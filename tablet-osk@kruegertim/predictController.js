// Prediction controller: glues the prediction engine (predict/*) to the OSK keyboard.
//
// Suggestions bar (iOS slot order), autocorrect on space/punctuation with one-step undo via BackSpace,
// learning of kept words, dynamic touch hit areas. Everything is disabled in password / sensitive /
// terminal / numeric fields. Engine data is loaded lazily the first time the keyboard is shown.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    PUNCTUATION, SEPARATORS, UndoLearnState, buildSlots, cpLength, dropLast, extractContext,
    predictionAllowed, resolveLanguage, tail, textBeforeCursor,
} from './predictLogic.js';

const SURROUNDING_SETTLE_MS = 300; // ignore surrounding-text updates this soon after our own output
const SLOW_REFRESH_MS = 12;
const LOAD_DELAY_MS = 400; // start loading after the slide-in animation of the first show
const EMPTY_SLOTS = [null, null, null];

function hasSignal(obj, name) {
    try {
        return !!obj && GObject.signal_lookup(name, obj.constructor.$gtype) !== 0;
    } catch (e) {
        return false;
    }
}

export class PredictController {
    constructor({settings, keyboard, extensionPath}) {
        this._settings = settings;
        this._keyboard = keyboard;
        this._extensionPath = extensionPath;

        this._engine = null;
        this._userDict = null;
        this._touch = null; // touch.js module
        this._mods = null;
        this._lang = null;
        this._loadState = 'idle'; // idle | loading | ready | failed
        this._loadGen = 0;
        this._readyLogged = false;

        this._buffer = ''; // known text before the cursor (tail)
        this._lastOwnEdit = 0; // monotonic µs of our last output
        this._editing = false; // true while we call deleteBackward/typeText ourselves
        this._autoSpace = false; // last output was a suggestion tap that appended ' '
        this._state = new UndoLearnState();
        this._slots = EMPTY_SLOTS;
        this._probsCache = {key: null, probs: null};
        this._acCache = {key: null, value: null};
        this._allowed = true;
        this._slowWarned = false;

        this._refreshId = 0;
        this._resyncId = 0;
        this._loadDelayId = 0;
        this._preparsed = new Map(); // data path -> JSON object parsed in an earlier idle slot
        this._sources = new Set();

        this._readSettings();

        const kb = keyboard;
        const kbSignals = [];
        if (hasSignal(kb, 'text-typed'))
            kbSignals.push('text-typed', (_k, str) => this._onTextTyped(str));
        if (hasSignal(kb, 'key-sent'))
            kbSignals.push('key-sent', (_k, name) => this._onKeySent(name));
        if (hasSignal(kb, 'suggestion-activated'))
            kbSignals.push('suggestion-activated', (_k, idx) => this._onSuggestionActivated(idx));
        if (hasSignal(kb, 'layout-changed'))
            kbSignals.push('layout-changed', () => this._applyKeyboardHooks());
        kbSignals.push('notify::mapped', () => this._onMappedChanged());
        kb.connectObject(...kbSignals, this);

        settings.connectObject(
            'changed::suggestions', () => this._onSettingsChanged(),
            'changed::autocorrect', () => this._onSettingsChanged(),
            'changed::dynamic-hitareas', () => this._onSettingsChanged(),
            'changed::prediction-language', () => this._onLanguageChanged(),
            'changed::layout', () => this._onLanguageChanged(),
            'changed::clear-userdict-request', () => this._clearUserDict(),
            this);

        const im = Main.inputMethod;
        if (im) {
            const imSignals = [
                'notify::content-purpose', () => this._onFieldChanged(),
                'notify::content-hints', () => this._onFieldChanged(),
                'input-panel-state', (_im, state) => {
                    if (state === Clutter.InputPanelState.ON)
                        this._onFieldChanged(true);
                },
            ];
            if (hasSignal(im, 'surrounding-text-set'))
                imSignals.push('surrounding-text-set', () => this._onSurroundingText());
            im.connectObject(...imSignals, this);
        }
        global.stage.connectObject('notify::key-focus', () => this._onFieldChanged(true), this);

        this._charFilter = ch => this._onCharFilter(ch);
        this._backspaceFilter = () => this._onBackspaceFilter();
        this._resolver = (pt, candidates) => this._resolveKey(pt, candidates);
        this._applyKeyboardHooks();

        if (kb.mapped)
            this._onMappedChanged();
    }

    // ---- public API -------------------------------------------------------------------------

    /** Forget the text context (focus change, hide). Learned data and blocked corrections stay. */
    reset() {
        this._learnActions(this._state.clearTransient());
        this._buffer = '';
        this._autoSpace = false;
        this._lastOwnEdit = 0;
        this._removeSource('_resyncId');
        this._syncFromSurrounding(true);
        this._queueRefresh();
    }

    /** Start loading the engine data (normally triggered automatically on the first show). */
    ensureLoaded() {
        if (this._loadState === 'idle')
            this._startLoad();
    }

    destroy() {
        this._loadGen++;
        this._removeSource('_refreshId');
        this._removeSource('_resyncId');
        this._removeSource('_loadDelayId');
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._keyboard?.disconnectObject(this);
        this._settings?.disconnectObject(this);
        Main.inputMethod?.disconnectObject(this);
        global.stage.disconnectObject(this);
        const kb = this._keyboard;
        if (kb) {
            try {
                kb.setCharFilter?.(null);
                kb.setBackspaceFilter?.(null);
                kb.setKeyResolver?.(null);
                kb.setSuggestions?.(EMPTY_SLOTS);
            } catch (e) {
                // keyboard already disposed
            }
        }
        try {
            this._userDict?.flush?.();
        } catch (e) {
            console.error(`[tablet-osk] userdict flush failed: ${e.message}`);
        }
        try {
            this._userDict?.destroy?.();
        } catch (e) {
            // ignore
        }
        this._engine = this._userDict = this._mods = this._touch = null;
        this._keyboard = this._settings = null;
    }

    // ---- keyboard hooks ----------------------------------------------------------------------

    _applyKeyboardHooks() {
        const kb = this._keyboard;
        if (!kb)
            return;
        const ready = this._loadState === 'ready' && this._allowed;
        kb.setCharFilter?.(ready && (this._autocorrect || this._suggestions) ? this._charFilter : null);
        kb.setKeyResolver?.(ready && this._dynamicHit && this._touch ? this._resolver : null);
        kb.setBackspaceFilter?.(ready && this._autocorrect ? this._backspaceFilter : null);
        kb.setSuggestionsEnabled?.(this._suggestions && this._allowed);
        if (!ready || !this._suggestions)
            this._setSlots(EMPTY_SLOTS);
        else
            this._queueRefresh();
    }

    _setSlots(slots) {
        this._slots = slots;
        this._keyboard?.setSuggestions?.(slots);
    }

    // ---- settings / field state --------------------------------------------------------------

    _readSettings() {
        const s = this._settings;
        this._suggestions = s.get_boolean('suggestions');
        this._autocorrect = s.get_boolean('autocorrect');
        this._dynamicHit = s.get_boolean('dynamic-hitareas');
    }

    _onSettingsChanged() {
        this._readSettings();
        this._applyKeyboardHooks();
    }

    _wantedLanguage() {
        return resolveLanguage(this._settings.get_string('prediction-language'),
            this._settings.get_string('layout'));
    }

    _onLanguageChanged() {
        try {
            this._engine?.setLayout?.(this._settings.get_string('layout'));
        } catch (e) {
            // ignore
        }
        const lang = this._wantedLanguage();
        if (lang === this._lang)
            return;
        if (this._loadState === 'ready' || this._loadState === 'failed') {
            this._loadState = 'idle';
            this._applyKeyboardHooks();
            if (this._keyboard?.mapped)
                this._startLoad();
        }
        // if loading: _finishLoad notices the mismatch and reloads
    }

    _computeAllowed() {
        const im = Main.inputMethod;
        const focus = global.stage.get_key_focus();
        if (focus instanceof Clutter.Text && focus.password_char)
            return false;
        if (!im || !im.currentFocus)
            return true; // no IM focus (e.g. X11 app without IM): nothing known, allow
        return predictionAllowed({
            purpose: im.content_purpose,
            hints: im.content_hints,
        }, {
            PASSWORD: Clutter.InputContentPurpose.PASSWORD,
            TERMINAL: Clutter.InputContentPurpose.TERMINAL,
            DIGITS: Clutter.InputContentPurpose.DIGITS,
            NUMBER: Clutter.InputContentPurpose.NUMBER,
            PHONE: Clutter.InputContentPurpose.PHONE,
            PIN: Clutter.InputContentPurpose.PIN, // does not exist in Clutter 14; filtered out
            HIDDEN_TEXT: Clutter.InputContentHintFlags.HIDDEN_TEXT,
            SENSITIVE_DATA: Clutter.InputContentHintFlags.SENSITIVE_DATA,
        });
    }

    _onFieldChanged(focusChanged = false) {
        const allowed = this._computeAllowed();
        const changed = allowed !== this._allowed;
        this._allowed = allowed;
        this._setPrivate(!allowed);
        if (focusChanged || !allowed) {
            // never carry context/pending learning into or out of a sensitive field
            if (!allowed)
                this._state.reset();
            this.reset();
        }
        if (changed)
            this._applyKeyboardHooks();
    }

    _setPrivate(isPrivate) {
        try {
            const ud = this._userDict;
            if (!ud)
                return;
            if (typeof ud.setPrivate === 'function')
                ud.setPrivate(isPrivate);
            else if (typeof ud.setPasswordMode === 'function')
                ud.setPasswordMode(isPrivate);
            else if ('private' in ud)
                ud.private = isPrivate;
        } catch (e) {
            // ignore
        }
    }

    _onMappedChanged() {
        if (this._keyboard?.mapped) {
            this._onFieldChanged(true);
            if (this._loadState === 'idle' && !this._loadDelayId) {
                this._loadDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOAD_DELAY_MS, () => {
                    this._loadDelayId = 0;
                    this.ensureLoaded();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this.reset();
        }
    }

    // ---- context tracking --------------------------------------------------------------------

    _context() {
        return extractContext(this._buffer);
    }

    _markOwnEdit() {
        this._lastOwnEdit = GLib.get_monotonic_time();
    }

    _onTextTyped(str) {
        if (this._editing || !str)
            return;
        this._buffer = tail(this._buffer + str);
        this._markOwnEdit();
        this._autoSpace = false;
        if (this._allowed)
            this._learnActions(this._state.typed(str));
        this._queueRefresh();
    }

    _onKeySent(name) {
        if (this._editing)
            return;
        switch (name) {
        case 'BackSpace': {
            this._buffer = dropLast(this._buffer);
            this._markOwnEdit();
            this._autoSpace = false;
            for (const a of this._state.backspace()) {
                if (a.type === 'revert')
                    this._revert(a);
            }
            break;
        }
        case 'Shift_L': case 'Shift_R': case 'Caps_Lock': case 'ISO_Level3_Shift':
        case 'Delete': case 'KP_Delete':
            return; // no effect on the text before the cursor
        case 'Return': case 'KP_Enter': case 'ISO_Enter':
            this._learnActions(this._state.other());
            this._buffer = tail(`${this._buffer}\n`);
            this._autoSpace = false;
            this._markOwnEdit();
            break;
        default:
            // arrows, Home/End, Tab, Escape, shortcuts …: cursor position unknown now
            this._learnActions(this._state.other());
            this._buffer = '';
            this._autoSpace = false;
            this._lastOwnEdit = 0; // adopt the next surrounding text immediately
            this._syncFromSurrounding(false);
            break;
        }
        this._queueRefresh();
    }

    _onSurroundingText() {
        const sinceMs = (GLib.get_monotonic_time() - this._lastOwnEdit) / 1000;
        if (sinceMs >= SURROUNDING_SETTLE_MS) {
            this._syncFromSurrounding(false);
            return;
        }
        // the app may not have processed our latest output yet; look again once it settled
        if (this._resyncId)
            return;
        this._resyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Math.ceil(SURROUNDING_SETTLE_MS - sinceMs) + 20, () => {
                this._resyncId = 0;
                const again = (GLib.get_monotonic_time() - this._lastOwnEdit) / 1000;
                if (again >= SURROUNDING_SETTLE_MS)
                    this._syncFromSurrounding(false);
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Adopt Main.inputMethod's surrounding text as the context if it is available. */
    _syncFromSurrounding(force) {
        const im = Main.inputMethod;
        if (!im || !im.currentFocus || typeof im.getSurroundingText !== 'function')
            return;
        const [text, cursor] = im.getSurroundingText();
        const before = textBeforeCursor(text, cursor);
        if (before === null)
            return;
        const next = tail(before);
        if (next === this._buffer)
            return;
        // consistent with what we typed (surrounding just knows more history): keep transient state
        const consistent = this._buffer.length > 0 && next.endsWith(this._buffer);
        if (!consistent && !force) {
            this._learnActions(this._state.clearTransient());
            this._autoSpace = false;
        }
        this._buffer = next;
        this._queueRefresh();
    }

    // ---- editing -----------------------------------------------------------------------------

    _edit(deleteCount, text) {
        const kb = this._keyboard;
        if (!kb)
            return;
        this._editing = true;
        try {
            if (deleteCount > 0)
                kb.deleteBackward?.(deleteCount);
            if (text)
                kb.typeText?.(text);
        } catch (e) {
            console.error(`[tablet-osk] prediction edit failed: ${e.message}`);
        } finally {
            this._editing = false;
        }
        let buf = this._buffer;
        for (let i = 0; i < deleteCount; i++)
            buf = dropLast(buf);
        this._buffer = tail(buf + (text ?? ''));
        this._markOwnEdit();
    }

    /** Called synchronously right before the keyboard outputs a printable char. */
    _onCharFilter(ch) {
        if (!SEPARATORS.has(ch) || this._loadState !== 'ready' || !this._allowed)
            return;
        // "word |" + "." -> "word." when the space came from a suggestion tap
        if (this._autoSpace && PUNCTUATION.has(ch) && this._buffer.endsWith(' ')) {
            this._autoSpace = false;
            this._edit(1, '');
            return;
        }
        this._autoSpace = false;
        const {word, prevWord} = this._context();
        if (!word)
            return;
        const correction = this._autocorrect ? this._correctionFor(word, prevWord) : null;
        if (correction) {
            this._edit(cpLength(word), correction);
            this._learnActions(this._state.corrected(word, correction, ch));
        } else {
            this._learnActions(this._state.wordEnded(word));
        }
    }

    /**
     * Called by the keyboard before it sends a BackSpace. If an autocorrect undo is armed and the
     * app has IM focus, do the whole undo as ONE input-method edit (delete replacement+separator,
     * commit original) and consume the BackSpace: a key event would reach the app after the IM
     * edit and garble the word.
     */
    _onBackspaceFilter() {
        const c = this._state.correction;
        if (!c || !c.armed || !this._allowed || !Main.inputMethod.currentFocus)
            return false;
        if (!this._buffer.endsWith(c.replacement + c.separator))
            return false;
        const actions = this._state.backspace();
        const a = actions.find(x => x.type === 'revert');
        if (!a)
            return false;
        this._autoSpace = false;
        this._edit(cpLength(c.replacement) + cpLength(c.separator), c.original);
        if (this._engine && this._allowed) {
            try {
                if (typeof this._engine.undoAutocorrect === 'function')
                    this._engine.undoAutocorrect(a.original, a.replacement);
                else
                    this._engine.learn(a.original);
            } catch (e) {
                console.error(`[tablet-osk] undoAutocorrect failed: ${e.message}`);
            }
        }
        this._acCache = {key: null, value: null};
        this._probsCache = {key: null, probs: null};
        this._queueRefresh();
        return true;
    }

    _revert(a) {
        // the BackSpace already removed the separator; swap the replacement back to the original
        const {word} = this._context();
        if (word !== a.replacement)
            return; // text is not what we expect (e.g. app ignored the edit) – do nothing
        this._edit(a.deleteCount, a.text);
        // counts the original as kept once and blocks this correction persistently
        if (this._engine && this._allowed) {
            try {
                if (typeof this._engine.undoAutocorrect === 'function')
                    this._engine.undoAutocorrect(a.original, a.replacement);
                else
                    this._engine.learn(a.original);
            } catch (e) {
                console.error(`[tablet-osk] undoAutocorrect failed: ${e.message}`);
            }
        }
        this._acCache = {key: null, value: null};
        this._probsCache = {key: null, probs: null};
    }

    _onSuggestionActivated(index) {
        const slot = this._slots[index];
        if (!slot || this._loadState !== 'ready' || !this._allowed)
            return;
        const {word} = this._context();
        if (slot.kind === 'literal') {
            this._learnActions(this._state.keptExplicitly(word));
            this._state.blocked.add(word.toLowerCase()); // do not "correct" it later in this session
            this._edit(0, ' ');
        } else {
            this._learnActions(this._state.other());
            let text = `${slot.text} `;
            if (!word && this._buffer && !/\s$/.test(this._buffer))
                text = ` ${text}`;
            this._edit(cpLength(word), text);
        }
        this._autoSpace = true;
        this._queueRefresh();
    }

    // ---- engine queries ----------------------------------------------------------------------

    /** Replacement string or null; cached per (prevWord, word). */
    _correctionFor(word, prevWord) {
        if (!this._engine || this._state.isBlocked(word))
            return null;
        const key = `${prevWord ?? ''}\u0001${word}`;
        if (this._acCache.key === key)
            return this._acCache.value;
        let value = null;
        try {
            const r = this._engine.autocorrect(word, prevWord);
            if (r && r.replacement && r.replacement !== word)
                value = r.replacement;
        } catch (e) {
            console.error(`[tablet-osk] autocorrect failed: ${e.message}`);
        }
        this._acCache = {key, value};
        return value;
    }

    _queueRefresh() {
        if (this._refreshId || this._loadState !== 'ready')
            return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (!this._engine || !this._suggestions || !this._allowed) {
            this._setSlots(EMPTY_SLOTS);
            return;
        }
        const t0 = GLib.get_monotonic_time();
        const {word, prevWord} = this._context();
        let slots = EMPTY_SLOTS;
        try {
            const suggestions = this._engine.suggest(word, prevWord, 3) ?? [];
            const replacement = word && this._autocorrect ? this._correctionFor(word, prevWord) : null;
            slots = buildSlots({
                word,
                suggestions,
                correction: replacement ? {replacement} : null,
                ordered: true, // predict/engine.js returns positional iOS slots
            });
        } catch (e) {
            console.error(`[tablet-osk] suggest failed: ${e.message}`);
        }
        this._setSlots(slots);
        const ms = (GLib.get_monotonic_time() - t0) / 1000;
        if (ms > SLOW_REFRESH_MS && !this._slowWarned) {
            this._slowWarned = true;
            console.warn(`[tablet-osk] slow suggestion refresh: ${ms.toFixed(1)} ms for "${word}"`);
        }
    }

    _resolveKey(pt, candidates) {
        if (!this._engine || !this._touch || !this._allowed || !candidates?.length)
            return null;
        const {word, prevWord} = this._context();
        const key = `${word ? '' : prevWord ?? ''}\u0001${word}`;
        if (this._probsCache.key !== key) {
            let probs = null;
            try {
                // prevWord only matters for the first letter of a word
                probs = this._engine.nextKeyProbs(word, word ? null : prevWord);
            } catch (e) {
                probs = null;
            }
            this._probsCache = {key, probs};
        }
        const probs = this._probsCache.probs;
        if (!probs)
            return null;
        try {
            // sigma defaults in touch.js: 0.45 × visible key size
            const r = this._touch.resolveTouch(pt, candidates, probs, {enabled: true});
            return typeof r === 'string' ? r : (r?.char ?? null);
        } catch (e) {
            return null;
        }
    }

    _learnActions(actions) {
        if (!actions?.length || !this._engine || !this._allowed)
            return;
        for (const a of actions) {
            if (a.type !== 'learn')
                continue;
            try {
                this._engine.learn(a.word);
            } catch (e) {
                console.error(`[tablet-osk] learn failed: ${e.message}`);
            }
        }
        this._acCache = {key: null, value: null};
        this._probsCache = {key: null, probs: null};
    }

    _clearUserDict() {
        this._state.reset();
        this._acCache = {key: null, value: null};
        this._probsCache = {key: null, probs: null};
        const doClear = ud => {
            try {
                ud?.clear?.();
            } catch (e) {
                console.error(`[tablet-osk] clearing userdict failed: ${e.message}`);
            }
        };
        if (this._userDict) {
            doClear(this._userDict);
            this._queueRefresh();
            return;
        }
        // not loaded yet: load the store module just to clear the file
        this._importModules().then(mods => {
            if (!this._settings)
                return;
            const ud = this._userDict ?? this._createUserDict(mods);
            doClear(ud);
            if (ud !== this._userDict) {
                ud?.flush?.();
                ud?.destroy?.();
            }
        }).catch(e => console.error(`[tablet-osk] clearing userdict failed: ${e.message}`));
    }

    // ---- lazy loading ------------------------------------------------------------------------

    _idle(fn) {
        return new Promise((resolve, reject) => {
            const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._sources.delete(id);
                try {
                    resolve(fn());
                } catch (e) {
                    reject(e);
                }
                return GLib.SOURCE_REMOVE;
            });
            this._sources.add(id);
        });
    }

    async _importModules() {
        if (this._mods)
            return this._mods;
        const base = GLib.filename_to_uri(`${this._extensionPath}/predict/`, null);
        const [engine, loader, touch, store] = await Promise.all(
            ['engine.js', 'loader.js', 'touch.js', 'store.js'].map(f => import(`${base}${f}`)));
        this._mods = {engine, loader, touch, store};
        return this._mods;
    }

    _readFile(path) {
        const full = GLib.path_is_absolute(path) ? path : `${this._extensionPath}/predict/data/${path}`;
        const [ok, bytes] = GLib.file_get_contents(full);
        if (!ok)
            throw new Error(`cannot read ${full}`);
        return bytes; // Uint8Array; loader.js decodes it
    }

    _createUserDict(mods) {
        const S = mods.store;
        const Cls = S.UserDict ?? S.default;
        if (!Cls)
            return null;
        return new Cls({});
    }

    _startLoad() {
        const gen = ++this._loadGen;
        const lang = this._wantedLanguage();
        this._loadState = 'loading';
        const t0 = GLib.get_monotonic_time();
        this._load(gen, lang).then(() => {
            if (gen !== this._loadGen)
                return;
            this._lang = lang;
            this._loadState = 'ready';
            this._slowWarned = false;
            if (!this._readyLogged) {
                this._readyLogged = true;
                const ms = (GLib.get_monotonic_time() - t0) / 1000;
                console.log(`[tablet-osk] prediction ready in ${Math.round(ms)} ms (${lang})`);
            }
            this._setPrivate(!this._allowed);
            this._acCache = {key: null, value: null};
            this._probsCache = {key: null, probs: null};
            this._applyKeyboardHooks();
            if (this._wantedLanguage() !== lang)
                this._onLanguageChanged();
        }).catch(e => {
            if (gen !== this._loadGen)
                return;
            this._loadState = 'failed';
            console.error(`[tablet-osk] prediction unavailable: ${e.message}`);
            this._applyKeyboardHooks();
        });
    }

    async _load(gen, lang) {
        const mods = await this._importModules();
        const stale = () => gen !== this._loadGen || !this._settings;
        if (stale())
            throw new Error('cancelled');
        this._touch = mods.touch;

        if (!this._userDict)
            this._userDict = await this._idle(() => this._createUserDict(mods));
        if (stale())
            throw new Error('cancelled');
        if (this._userDict?.load && !this._userDict._toskLoaded) {
            const r = this._userDict.load();
            if (r && typeof r.then === 'function')
                await r;
            this._userDict._toskLoaded = true;
        }

        // reading + JSON.parse (~60 ms for de) and building the indexes (~30 ms) are the big
        // chunks; each gets its own idle slot so no single main-loop iteration blocks for long
        const dl = this._ensureLoader(mods.loader);
        if (dl && !dl.has?.(lang)) {
            await this._idle(() => {
                const path = dl.path(lang);
                const obj = JSON.parse(new TextDecoder('utf-8').decode(this._readFile(path)));
                this._preparsed.set(path, obj);
            });
            if (stale())
                throw new Error('cancelled');
        }
        const data = await this._idle(() => this._loadData(mods.loader, lang));
        const resolved = data && typeof data.then === 'function' ? await data : data;
        if (stale())
            throw new Error('cancelled');

        this._engine = await this._idle(() => {
            const Engine = mods.engine.PredictionEngine;
            const engine = new Engine({
                lexicon: resolved.lexicon,
                bigrams: resolved.bigrams,
                userDict: this._userDict,
                loader: this._loader ?? null,
                lang,
                layout: this._settings.get_string('layout'),
            });
            return engine;
        });
        // Build the lazy indexes now, in their own idle slot, so the first keystroke doesn't pay for it.
        await this._idle(() => this._engine?.warmUp?.());
        if (stale())
            throw new Error('cancelled');
    }

    _ensureLoader(loader) {
        if (!this._loader && typeof loader.DataLoader === 'function') {
            this._loader = new loader.DataLoader({
                // pre-parsed object if available (loader.parseLanguageData accepts objects)
                readFile: p => {
                    const obj = this._preparsed.get(p);
                    if (obj) {
                        this._preparsed.delete(p);
                        return obj;
                    }
                    return this._readFile(p);
                },
                dataDir: `${this._extensionPath}/predict/data`,
            });
        }
        return this._loader ?? null;
    }

    _loadData(loader, lang) {
        const dl = this._ensureLoader(loader);
        if (dl)
            return dl.load(lang);
        if (typeof loader.loadLanguage === 'function')
            return loader.loadLanguage(lang, p => this._readFile(p));
        throw new Error('predict/loader.js: no known load function');
    }

    _removeSource(prop) {
        if (this[prop]) {
            GLib.source_remove(this[prop]);
            this[prop] = 0;
        }
    }
}
