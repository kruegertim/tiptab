// OskKeyboard: the key grid widget.
//
//   [grab bar (floating mode only)]
//   suggestion bar: slot 0 | slot 1 (emphasised) | slot 2 (hidden when suggestions are off)
//   rows of keys
//   [footer with resize grip (floating mode only)]
//
// Input model (Amendment 3 U): every pointer / touch sequence that starts on the
// keyboard is tracked independently in a 'captured-event' handler on the keyboard.
// Normal keys fire on *release* (or after the 500 ms auto-repeat delay), so a
// downward swipe that starts on a key never produces output; it emits
// 'swipe-progress'(dy) while following the finger and 'swipe-hide' / 'swipe-cancel'
// on release. Modifiers are active while held (chording, multi-touch) and toggle
// their latch on release (see _modUp()).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {getLayout, getSplitLayout, TOTAL_UNITS, SPLIT_TOTAL_UNITS, FALLBACK_KEYVALS} from './layouts.js';
import {KeyInjector} from './injector.js';
import {isWaylandCompositor} from './compat.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 50;
const SHIFT_DOUBLE_TAP_MS = 400;
const SUPER_LONG_PRESS_MS = 450;
const SUPER_DOUBLE_TAP_MS = 400;
const DEFAULT_HOLD_MS = 1000;
const FLOAT_BORDER_PX = 1;

// Swipe-down recognition, in multiples of the key height.
const SWIPE_SLOP = 0.25;    // start following the finger
const SWIPE_TRIGGER = 1.0;  // the sequence becomes a swipe (pending key cancelled)
const SWIPE_COMMIT = 0.5;   // on release: still this far down -> hide, else snap back

const DIM_OPACITY = 115;    // ~45 % for inactive keycap glyphs

const LATCH_MODIFIERS = ['altgr', 'fn', 'ctrl', 'alt', 'super'];
const SUPER_SYMBOLS = ['fish', 'tux', 'diamond', 'text'];

const ICONS_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
const FISH_ICON_FILE = ICONS_DIR.get_child('fish-symbolic.svg');
const TUX_ICON_FILE = ICONS_DIR.get_child('tux-symbolic.svg');

function resolveKeyval(name) {
    if (!name)
        return 0;
    if (typeof name === 'number')
        return name;
    return Clutter[`KEY_${name}`] ?? FALLBACK_KEYVALS[name] ?? 0;
}

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

const S = Clutter.ActorAlign.START, E = Clutter.ActorAlign.END, C = Clutter.ActorAlign.CENTER;

// ---------------------------------------------------------------- Key

// Keycap grid for keys with several glyphs: shift top-left, base bottom-left, AltGr
// bottom-right. Glyphs are placed by their text baseline, not by their label box, so
// characters drawn from fallback fonts (´ § µ „ …) or with accents/descenders sit on
// exactly the same lines as all others. The baselines come from the primary font's
// ascent/descent, so they are identical on every key of a given height.
const GLYPH_FONT_FAMILIES = 'Liberation Sans,Nimbus Sans,Noto Sans,sans-serif';

const GlyphGridLayout = GObject.registerClass(
class TabletOskGlyphGridLayout extends Clutter.LayoutManager {
    _init(slots) {
        super._init();
        this._slots = slots; // {topLeft, bottomLeft, bottomRight} St.Label|null
        this._fontPx = 0;
        this._desc = null;
        this._metrics = null;
        this._probe = null;
    }

    // Called by OskKey.setHeight() with the .tosk-glyph font size. The font
    // description is built here instead of read from the labels: reading
    // ClutterText.font_description from JS corrupts it on GNOME 50 (gjs frees the
    // borrowed boxed), which later crashes the shell in pango.
    setFontPx(px) {
        if (px === this._fontPx)
            return;
        this._fontPx = px;
        // Same family list as .tosk-keyboard in stylesheet.css.
        const desc = Pango.FontDescription.from_string(GLYPH_FONT_FAMILIES);
        desc.set_absolute_size(px * Pango.SCALE);
        desc.set_weight(Pango.Weight.BOLD); // .tosk-glyph is bold
        this._desc = desc;
        this._metrics = null;
        this.layout_changed();
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    _ensureMetrics(label) {
        if (this._metrics)
            return;
        const ctx = label.get_pango_context();
        const fm = ctx.get_metrics(this._desc, null);
        this._metrics = {
            ascent: fm.get_ascent() / Pango.SCALE,
            descent: fm.get_descent() / Pango.SCALE,
        };
        this._probe = Pango.Layout.new(ctx);
        this._probe.set_font_description(this._desc);
    }

    _place(label, align, baseline, width) {
        const [, natW] = label.get_preferred_width(-1);
        const [, natH] = label.get_preferred_height(natW);
        // Baseline of this text's line (includes fallback fonts used for it).
        this._probe.set_text(label.text, -1);
        const labelBaseline = this._probe.get_baseline() / Pango.SCALE;
        const box = new Clutter.ActorBox();
        box.set_origin(align === 'right' ? Math.round(width - natW) : 0,
            Math.round(baseline - labelBaseline));
        box.set_size(natW, natH);
        label.allocate(box);
    }

    vfunc_allocate(_container, box) {
        const {topLeft, bottomLeft, bottomRight} = this._slots;
        const ref = topLeft ?? bottomLeft ?? bottomRight;
        if (!ref || !this._desc)
            return;
        this._ensureMetrics(ref);
        const w = box.get_width();
        const h = box.get_height();
        const topBaseline = Math.round(this._metrics.ascent);
        const bottomBaseline = Math.round(h - this._metrics.descent);
        if (topLeft)
            this._place(topLeft, 'left', topBaseline, w);
        if (bottomLeft)
            this._place(bottomLeft, 'left', bottomBaseline, w);
        if (bottomRight)
            this._place(bottomRight, 'right', bottomBaseline, w);
    }
});

const OskKey = GObject.registerClass(
class OskKey extends St.Widget {
    _init(def, keyboard) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: false,
            track_hover: false,
            style_class: 'tosk-key',
        });
        this.def = def;
        this.units = def.w;
        this.twin = null; // other half of the ISO Enter key
        this._keyboard = keyboard;

        if (def.special)
            this.add_style_class_name('tosk-key-special');
        if (def.fnStyle)
            this.add_style_class_name('tosk-key-fn');
        if (def.space)
            this.add_style_class_name('tosk-key-space');
        if (def.enterPart === 'top')
            this.add_style_class_name('tosk-enter-top');
        if (def.enterPart === 'bottom')
            this.add_style_class_name('tosk-enter-bottom');
        // ISO Enter: the lower half reaches up through the row gap to join the upper
        // half. (Extending the upper half down instead would cover the gap above '#'.)
        this.extendUp = def.enterPart === 'bottom';

        this._buildGlyphs(def, keyboard._superSymbol);

        this._toskTarget = {
            down: st => keyboard._keyDown(this, st),
            up: st => keyboard._keyUp(this, st),
            cancel: st => keyboard._keyCancel(this, st),
        };
    }

    _corner(x, y, cls, text) {
        const l = new St.Label({
            text,
            style_class: cls,
            x_expand: true,
            y_expand: true,
            x_align: x,
            y_align: y,
        });
        this.add_child(l);
        return l;
    }

    _buildGlyphs(def, superSymbol) {
        this._main = null;        // single label (special keys, plain letters)
        this._mainKind = 'big';   // 'big' | 'text' | 'small'
        this._mainIcon = null;
        this._glyphs = null;      // {base, shift, altgr} for char keys (level dimming)
        this._multi = false;      // char key with several same-size glyphs
        this._gridLayout = null;  // GlyphGridLayout of a multi-glyph key

        if (def.type === 'char' && !def.space && def.label) {
            const base = def.label;
            const shift = def.letter ? null : def.shiftLabel ?? null;
            const altgr = def.altgrLabel ?? null;
            if (!shift) {
                // Letter (or single glyph): one big centred label, like every other
                // letter key. Letters with an AltGr glyph (Q @, E €, M µ) add it small
                // in the bottom-right grid slot, so the letter stays centred.
                this._main = this._corner(C, C, 'tosk-label-main', base);
                this._glyphs = {base: this._main, shift: null, altgr: null};
                if (altgr) {
                    const a = new St.Label({text: altgr, style_class: 'tosk-glyph tosk-glyph-altgr'});
                    this._gridLayout = new GlyphGridLayout({topLeft: null, bottomLeft: null, bottomRight: a});
                    const grid = new St.Widget({
                        x_expand: true,
                        y_expand: true,
                        layout_manager: this._gridLayout,
                    });
                    grid.add_child(a);
                    this.add_child(grid);
                    this._glyphs.altgr = a;
                }
            } else {
                // Real keycap arrangement: shift top-left, base bottom-left, AltGr
                // bottom-right.
                this._multi = true;
                const glyph = (cls, text) => new St.Label({text, style_class: cls});
                const g = {base: glyph('tosk-glyph', base), shift: null, altgr: null};
                if (shift)
                    g.shift = glyph('tosk-glyph', shift);
                if (altgr)
                    g.altgr = glyph('tosk-glyph tosk-glyph-altgr', altgr);
                this._gridLayout = new GlyphGridLayout({
                    topLeft: shift ? g.shift : g.base,
                    bottomLeft: shift ? g.base : null,
                    bottomRight: g.altgr,
                });
                const grid = new St.Widget({
                    x_expand: true,
                    y_expand: true,
                    layout_manager: this._gridLayout,
                });
                for (const l of [g.shift, g.base, g.altgr]) {
                    if (l)
                        grid.add_child(l);
                }
                this.add_child(grid);
                this._glyphs = g;
            }
        } else if (def.type === 'modifier' && def.modifier === 'super') {
            if (superSymbol === 'text') {
                this._main = this._corner(S, S, 'tosk-label-main tosk-label-small', 'Super');
                this._mainKind = 'small';
            } else if (superSymbol === 'diamond') {
                this._main = this._corner(C, C, 'tosk-label-main', '◆');
            } else {
                this._mainIcon = new St.Icon({
                    gicon: new Gio.FileIcon({file: superSymbol === 'tux' ? TUX_ICON_FILE : FISH_ICON_FILE}),
                    style_class: 'tosk-icon-main tosk-icon-fish',
                    x_expand: true, y_expand: true, x_align: C, y_align: C,
                });
                this.add_child(this._mainIcon);
            }
        } else if (def.icon) {
            this._mainIcon = new St.Icon({
                icon_name: def.icon,
                style_class: 'tosk-icon-main',
                x_expand: true, y_expand: true, x_align: C, y_align: C,
            });
            this.add_child(this._mainIcon);
        } else if (def.label) {
            const topLeft = def.labelPos === 'tl';
            this._main = this._corner(topLeft ? S : C, topLeft ? S : C,
                topLeft ? 'tosk-label-main tosk-label-small' : 'tosk-label-main', def.label);
            if (topLeft)
                this._mainKind = 'small';
            else if ([...def.label].length > 1)
                this._mainKind = 'text';
        }

        this._fnBox = null;
        this._fnIcon = null;
        this._fnText = null;
        if (def.fnIcon || def.fnLabel) {
            this._fnBox = new St.BoxLayout({
                style_class: 'tosk-fn-box',
                x_expand: true, y_expand: true,
                x_align: def.fnCentre ? C : E,
                y_align: def.fnCentre ? C : S,
            });
            if (def.fnIcon) {
                this._fnIcon = new St.Icon({icon_name: def.fnIcon, style_class: 'tosk-fn-icon'});
                this._fnBox.add_child(this._fnIcon);
            }
            if (def.fnLabel) {
                this._fnText = new St.Label({
                    text: def.fnLabel,
                    style_class: 'tosk-label-fn',
                    y_align: C,
                });
                this._fnBox.add_child(this._fnText);
            }
            this.add_child(this._fnBox);
        }
    }

    setHeight(h) {
        const big = Math.round(h * 0.4);
        const glyph = Math.round(h * 0.32);
        const small = Math.max(7, Math.round(h * 0.2));
        const narrow = this.units < 0.75; // compact-mode Esc / ^ (0.5 u)
        const padV = Math.round(h * 0.07), padH = Math.round(h * (narrow ? 0.04 : 0.11));
        this.style = `padding: ${padV}px ${padH}px;`;

        if (this._multi) {
            for (const g of Object.values(this._glyphs)) {
                if (g)
                    g.style = `font-size: ${glyph}px;`;
            }
            this._gridLayout.setFontPx(glyph);
        } else if (this._main) {
            if (this._glyphs?.altgr) {
                this._glyphs.altgr.style = `font-size: ${glyph}px;`;
                this._gridLayout.setFontPx(glyph);
            }
            let size = big;
            if (this._mainKind === 'small')
                size = Math.round(h * (narrow ? 0.2 : 0.24));
            else if (this._mainKind === 'text')
                size = Math.round(h * 0.3);
            this._main.style = `font-size: ${size}px;`;
        }
        if (this._mainIcon)
            this._mainIcon.icon_size = Math.round(h * (this.def.modifier === 'super' ? 0.46 : 0.4));
        if (this._fnIcon)
            this._fnIcon.icon_size = Math.round(h * (this.def.fnCentre ? 0.34 : 0.22));
        if (this._fnText)
            this._fnText.style = `font-size: ${this.def.fnCentre ? Math.round(h * 0.26) : small}px;`;
    }

    // Highlight the glyph that the next tap produces; dim the others while
    // Shift or AltGr is active.
    setLevel(shiftOn, altgrOn) {
        if (!this._glyphs)
            return;
        const {base, shift, altgr} = this._glyphs;
        let active = base;
        if (altgrOn && altgr)
            active = altgr;
        else if (shiftOn && shift)
            active = shift;
        const any = shiftOn || altgrOn;
        for (const g of [base, shift, altgr]) {
            if (g)
                g.opacity = !any || g === active ? 255 : DIM_OPACITY;
        }
    }

    setActive(active) {
        for (const k of [this, this.twin]) {
            if (!k)
                continue;
            if (active)
                k.add_style_pseudo_class('active');
            else
                k.remove_style_pseudo_class('active');
        }
    }

    setLatched(latched, locked = false) {
        for (const k of [this, this.twin]) {
            if (!k)
                continue;
            if (latched || locked)
                k.add_style_class_name('tosk-latched');
            else
                k.remove_style_class_name('tosk-latched');
            if (locked)
                k.add_style_class_name('tosk-locked');
            else
                k.remove_style_class_name('tosk-locked');
        }
    }

    resetPress() {
        this.setActive(false);
    }
});

// ---------------------------------------------------------------- Row

const KeyRow = GObject.registerClass(
class KeyRow extends St.Widget {
    _init(keyboard) {
        super._init({style_class: 'tosk-row', x_expand: true});
        this._keyboard = keyboard;
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        const h = this._keyboard._keyHeight;
        return [h, h];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const gap = this._keyboard._gap;
        const width = content.x2 - content.x1;
        // Unit includes one gap so key edges line up across rows.
        const unit = (width + gap) / this._keyboard._totalUnits;
        let cum = 0;
        for (const child of this.get_children()) {
            const x1 = content.x1 + Math.round(cum * unit);
            cum += child.units;
            const x2 = Math.max(x1, content.x1 + Math.round(cum * unit) - gap);
            const y1 = content.y1 - (child.extendUp ? gap : 0);
            child.allocate(Clutter.ActorBox.new(x1, y1, x2, content.y2));
        }
    }
});

// ---------------------------------------------------------------- Suggestion slot

// Flat touch area; requests no width so the homogeneous box splits the bar
// into exactly equal thirds regardless of the text lengths.
const SuggestSlot = GObject.registerClass(
class SuggestSlot extends St.Widget {
    _init(index) {
        super._init({
            style_class: 'tosk-suggest-slot',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            can_focus: false,
            track_hover: false,
            x_expand: true,
            y_expand: true,
        });
        if (index === 1)
            this.add_style_class_name('tosk-suggest-main');
        this.label = new St.Label({
            style_class: 'tosk-suggest-label',
            x_expand: true, y_expand: true, x_align: C, y_align: C,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this.label);
        this.divider = null;
        if (index > 0) {
            this.divider = new St.Widget({
                style_class: 'tosk-suggest-divider',
                x_expand: true, y_expand: true, x_align: S, y_align: C,
            });
            this.add_child(this.divider);
        }
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
});

// ---------------------------------------------------------------- Keyboard

export const OskKeyboard = GObject.registerClass({
    Signals: {
        'hide-request': {},
        'settings-request': {},
        'layout-changed': {}, // emitted after a rebuild (row count may change)
        'key-sent': {param_types: [GObject.TYPE_STRING]}, // keysym name of special keys (Return, BackSpace, …)
        'text-typed': {param_types: [GObject.TYPE_STRING]}, // printable output of a key
        'suggestion-activated': {param_types: [GObject.TYPE_INT]},
        'swipe-progress': {param_types: [GObject.TYPE_DOUBLE]}, // downward offset (px) while following a swipe
        'swipe-hide': {},
        'swipe-cancel': {},
    },
}, class OskKeyboard extends St.BoxLayout {
    _init({settings}) {
        super._init({
            vertical: true,
            reactive: true,
            x_expand: true,
            style_class: 'tosk-keyboard',
        });
        this._settings = settings;
        this._injector = new KeyInjector();

        this._keyHeight = 48;
        this._gap = 4;
        this._pad = 4;
        this._gripH = 24;
        this._barH = 36;
        this._floating = false;

        this._shift = 0; // 0 off, 1 one-shot, 2 locked
        this._lastShiftTap = 0;
        this._caps = false;
        this._latched = new Set();
        this._held = new Map();   // modifier -> {t0, used}: active while its key is held
        this._extraMods = null;   // held modifiers captured when the activated key went down

        this._seqs = new Map();   // sequence id -> state (see _onCapturedEvent)
        this._repeatSt = null;
        this._repeatId = 0;
        this._superTimerId = 0;

        this._suggestionsEnabled = true;
        this._slotData = [null, null, null];
        this._charFilter = null;
        this._keyResolver = null;

        this._superSymbol = this._readSuperSymbol();
        this._noopTarget = {down() {}, up() {}, cancel() {}};

        this._keys = [];
        this._rows = [];

        this._buildHandle();
        this._buildSuggestionBar();
        this._bar.visible = this._settings.get_boolean('suggestions');
        this._rowsBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tosk-rows'});
        this.add_child(this._rowsBox);
        this._buildFooter();
        this._syncBarPosition(false);

        this.connect('captured-event', (_a, event) => this._onCapturedEvent(event));

        this._settings.connectObject(
            'changed::layout', () => this._rebuild(),
            'changed::show-f-row', () => this._rebuild(),
            'changed::label-brightness', () => this._applyContainerStyle(),
            'changed::suggestions', () => this._syncBarVisible(),
            'changed::suggestion-bar-position', () => this._syncBarPosition(),
            'changed::super-symbol', () => {
                const sym = this._readSuperSymbol();
                if (sym !== this._superSymbol) {
                    this._superSymbol = sym;
                    this._rebuild();
                }
            },
            this);

        this.connect('destroy', () => this._onDestroy());
        // Safety: release everything when a modal shell UI takes over (overview, screenshot UI).
        Main.overview.connectObject('showing', () => this.resetModifiers(), this);
        Main.screenshotUI?.connectObject('notify::visible', () => {
            if (Main.screenshotUI.visible)
                this.resetModifiers();
        }, this);

        this._rebuild(false);
        this.setKeyHeight(this._keyHeight);
    }

    // ------------------------------------------------------------ settings helpers

    _hasKey(key) {
        try {
            return !!this._settings?.settings_schema?.has_key(key);
        } catch (e) {
            return false;
        }
    }

    _readSuperSymbol() {
        if (!this._hasKey('super-symbol'))
            return 'fish';
        const v = this._settings.get_string('super-symbol');
        return SUPER_SYMBOLS.includes(v) ? v : 'fish';
    }

    _holdEnabled() {
        return this._hasKey('modifier-hold-release')
            ? this._settings.get_boolean('modifier-hold-release') : true;
    }

    _holdMs() {
        return this._hasKey('modifier-hold-ms')
            ? this._settings.get_int('modifier-hold-ms') : DEFAULT_HOLD_MS;
    }

    _swipeEnabled() {
        return this._hasKey('swipe-gestures') ? this._settings.get_boolean('swipe-gestures') : true;
    }

    // ------------------------------------------------------------ public API

    /** Floating mode: the grab bar above the suggestion bar. Docked mode: null. */
    get handle() {
        return this._floating ? this._handle : null;
    }

    get resizeGrip() {
        return this._resizeGrip;
    }

    get floating() {
        return this._floating;
    }

    get rowCount() {
        return this._rows.length;
    }

    get suggestionBarHeight() {
        return this._barH;
    }

    setKeyHeight(px) {
        const h = Math.max(12, Math.round(px));
        this._keyHeight = h;
        this._gap = Math.min(8, Math.max(3, Math.round(h * 0.08)));
        this._pad = this._gap;
        this._gripH = Math.max(18, Math.round(h * 0.45));
        this._barH = Math.max(36, Math.round(h * 0.7));
        const btnW = Math.max(36, Math.round(h * 0.9));

        this._applyContainerStyle();
        this._applyRowsStyle();

        this._handle.height = this._gripH;
        this._grip.set_size(Math.max(32, Math.round(h * 0.9)), 5);

        this._bar.height = this._barH;
        const divH = Math.round(this._barH * 0.5);
        const font = Math.round(this._barH * 0.42);
        for (const slot of this._slots) {
            slot.divider?.set_size(1, divH);
            slot.label.style = `font-size: ${font}px; padding: 0 ${Math.round(font * 0.4)}px;`;
        }

        this._footer.height = this._gripH;
        this._resizeGrip.set_size(btnW, this._gripH);
        this._resizeGripLabel.style = `font-size: ${Math.round(this._gripH * 0.75)}px;`;

        for (const k of this._keys)
            k.setHeight(h);
        this.queue_relayout();
    }

    get preferredHeight() {
        const n = this._rows.length;
        const bar = this._bar.visible
            ? this._barH + (this._barAtBottom ? this._gap : 0) : 0;
        let height = bar + this._gap + n * this._keyHeight +
            Math.max(0, n - 1) * this._gap + this._pad;
        if (this._floating)
            height += 2 * this._gripH + 2 * FLOAT_BORDER_PX;
        return height;
    }

    // Thumb mode: the keyboard stays reactive (Clutter only emits captured-event on
    // reactive ancestors, which the key/swipe handling relies on) but does not pick
    // its own box, so the transparent middle passes touches to the app.
    vfunc_pick(pickContext) {
        if (!this._thumb) {
            super.vfunc_pick(pickContext);
            return;
        }
        for (const child of this.get_children())
            child.pick(pickContext);
    }

    get _totalUnits() {
        return this._thumb ? SPLIT_TOTAL_UNITS : TOTAL_UNITS;
    }

    get thumb() {
        return !!this._thumb;
    }

    // Thumb mode: split layout, transparent middle (only keys and the bar are
    // reactive), the suggestion bar as a strip over the middle gap.
    setThumb(thumb) {
        thumb = !!thumb;
        if (!!this._thumb === thumb)
            return;
        this._thumb = thumb;
        if (thumb)
            this.add_style_class_name('tosk-thumb');
        else
            this.remove_style_class_name('tosk-thumb');
        this._bar.x_expand = !thumb;
        this._bar.x_align = thumb ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
        this._rebuild();
    }

    /**
     * Thumb mode: width of the suggestion strip over the middle gap and its horizontal
     * offset from the keyboard centre (the halves differ in width).
     */
    setBarWidth(px, offset = 0) {
        this._bar.width = px > 0 ? px : -1;
        this._bar.translation_x = px > 0 ? Math.round(offset) : 0;
    }

    setFloating(floating) {
        floating = !!floating;
        if (this._floating === floating)
            return;
        this._floating = floating;
        if (floating)
            this.add_style_class_name('tosk-floating');
        else
            this.remove_style_class_name('tosk-floating');
        this._handle.visible = floating;
        this._footer.visible = floating;
        this._applyContainerStyle();
        this.queue_relayout();
    }

    resetModifiers() {
        this._stopRepeat();
        this._clearSuperTimer();
        if ([...this._seqs.values()].some(st => st.candidate))
            this.emit('swipe-cancel');
        this._seqs.clear();
        this._held.clear();
        this._extraMods = null;
        for (const k of this._keys)
            k.resetPress();
        for (const s of this._slots)
            s.remove_style_pseudo_class('active');
        this._injector?.releaseAll();
        this._shift = 0;
        this._latched.clear();
        this._updateModifierState();
    }

    // ---- prediction hooks (Amendment 3 U4) ----

    /** @param {Array<{text: string, kind: string}|null>} slots  three entries */
    setSuggestions(slots) {
        this._slotData = [0, 1, 2].map(i => slots?.[i] ?? null);
        this._renderSuggestions();
    }

    setSuggestionsEnabled(enabled) {
        this._suggestionsEnabled = !!enabled;
        this._renderSuggestions();
    }

    /** fn(char) is called synchronously right before a printable char is output. */
    setCharFilter(fn) {
        this._charFilter = typeof fn === 'function' ? fn : null;
    }

    /** fn({x, y}, candidates) -> char|null; candidates: visible letter keys in stage coords. */
    setKeyResolver(fn) {
        this._keyResolver = typeof fn === 'function' ? fn : null;
    }

    /** Delete n characters before the cursor (no signals emitted). */
    deleteBackward(n) {
        n = Math.max(0, Math.floor(n));
        if (!n || !this._injector)
            return;
        if (Main.inputMethod.currentFocus) {
            try {
                Main.inputMethod.delete_surrounding(-n, n);
                return;
            } catch (e) {
                console.error(`[tablet-osk] delete_surrounding: ${e}`);
            }
        }
        for (let i = 0; i < n; i++)
            this._injector.tap(Clutter.KEY_BackSpace);
    }

    /** Insert text as-is (no shift/caps, one-shot modifiers untouched, no signals emitted). */
    /** fn() -> true to consume a plain BackSpace before it is sent (autocorrect undo). */
    setBackspaceFilter(fn) {
        this._backspaceFilter = fn ?? null;
    }

    typeText(str) {
        if (!str || !this._injector)
            return;
        // Inside the char filter (autocorrect) the replacement is merged with the following
        // character into ONE commit: Wayland text-input-v3 keeps only the last commit_string
        // per 'done', so two commits in a row would lose the replacement.
        if (this._inCharFilter) {
            this._pendingText += str;
            return;
        }
        this._injector.typeChar(str, []);
    }

    // ------------------------------------------------------------ building

    _applyContainerStyle() {
        const p = this._pad;
        let style = `padding: 0 ${p}px ${p}px ${p}px; spacing: 0;`;
        if (this._floating)
            style += ` border-width: ${FLOAT_BORDER_PX}px;`;
        // Label colour (inherited by all keys): grey level from label-brightness,
        // 1.0 = #f5f5f5. Even the minimum (0.65) keeps >= 7:1 contrast on #141414.
        const b = Math.min(1, Math.max(0.65, this._settings.get_double('label-brightness')));
        const v = Math.round(245 * b);
        style += ` color: rgb(${v}, ${v}, ${v});`;
        this.style = style;
    }

    _buildHandle() {
        // Floating mode only: grab bar (FloatingController drags the container with it).
        this._handle = new St.Widget({
            style_class: 'tosk-handle',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: false,
            x_expand: true,
            visible: false,
        });
        this._grip = new St.Widget({
            style_class: 'tosk-handle-grip',
            x_expand: true, y_expand: true,
            x_align: C, y_align: C,
        });
        this._handle.add_child(this._grip);
        this.add_child(this._handle);
    }

    _buildSuggestionBar() {
        this._bar = new St.BoxLayout({
            style_class: 'tosk-suggest-bar',
            reactive: true,
            x_expand: true,
        });
        this._bar._toskTarget = this._noopTarget; // swipe-down also works on the bar

        // No gear here: the settings panel opens with Fn+Space. The bar is shown
        // only while the 'suggestions' setting is on (see _syncBarVisible()).
        this._slotsBox = new St.BoxLayout({x_expand: true, y_expand: true});
        this._slotsBox.layout_manager.homogeneous = true;
        this._slots = [];
        for (let i = 0; i < 3; i++) {
            const slot = new SuggestSlot(i);
            slot._toskTarget = {
                down: () => slot.add_style_pseudo_class('active'),
                up: () => {
                    slot.remove_style_pseudo_class('active');
                    if (this._suggestionsEnabled && this._slotData[i])
                        this.emit('suggestion-activated', i);
                },
                cancel: () => slot.remove_style_pseudo_class('active'),
            };
            this._slots.push(slot);
            this._slotsBox.add_child(slot);
        }
        this._bar.add_child(this._slotsBox);
        this.add_child(this._bar);
    }

    get _barAtBottom() {
        return this._hasKey('suggestion-bar-position') &&
            this._settings.get_string('suggestion-bar-position') === 'bottom';
    }

    // Gap above the first row always; with the bar below the keys also one below the
    // last row (between keys and bar).
    _applyRowsStyle() {
        const g = this._gap;
        const below = this._barAtBottom && this._bar.visible ? g : 0;
        this._rowsBox.style = `spacing: ${g}px; padding-top: ${g}px; padding-bottom: ${below}px;`;
    }

    // Suggestion bar above (default) or below the keys; live.
    _syncBarPosition(notify = true) {
        if (this._barAtBottom)
            this.set_child_above_sibling(this._bar, this._rowsBox);
        else
            this.set_child_below_sibling(this._bar, this._rowsBox);
        this._applyRowsStyle();
        if (notify) {
            this.queue_relayout();
            this.emit('layout-changed');
        }
    }

    // Without suggestions the bar goes away entirely and the keyboard (and the
    // reserved work area) gets shorter by its height; autocorrect works without it.
    _syncBarVisible() {
        const visible = this._settings.get_boolean('suggestions');
        if (this._bar.visible === visible)
            return;
        this._bar.visible = visible;
        this._applyRowsStyle();
        this.queue_relayout();
        this.emit('layout-changed');
    }

    _renderSuggestions() {
        for (let i = 0; i < 3; i++) {
            const slot = this._slots[i];
            const data = this._suggestionsEnabled ? this._slotData[i] : null;
            let text = data?.text ?? '';
            if (text && data.kind === 'literal')
                text = `„${text}“`;
            slot.label.text = text;
            slot.reactive = !!text;
            if (!text)
                slot.remove_style_pseudo_class('active');
        }
    }

    _buildFooter() {
        this._footer = new St.Widget({
            style_class: 'tosk-footer',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            visible: false,
        });
        // The FloatingController attaches its drag handling to this actor.
        this._resizeGrip = new St.Widget({
            style_class: 'tosk-resize-grip',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: false,
            x_expand: true, y_expand: true,
            x_align: E,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._resizeGripLabel = new St.Label({
            text: '⇲',
            x_expand: true, y_expand: true,
            x_align: E, y_align: C,
        });
        this._resizeGrip.add_child(this._resizeGripLabel);
        this._footer.add_child(this._resizeGrip);
        this.add_child(this._footer);
    }

    _rebuild(emit = true) {
        this._stopRepeat();
        this._clearSuperTimer();
        this._seqs.clear();
        this._held.clear();
        this._injector.releaseAll();
        this._rowsBox.destroy_all_children();
        this._keys = [];
        this._modifierKeys = {};
        this._rows = this._thumb
            ? getSplitLayout({layout: this._settings.get_string('layout')})
            : getLayout({
                layout: this._settings.get_string('layout'),
                fRow: this._settings.get_boolean('show-f-row'),
            });

        const enterParts = [];
        for (const rowDef of this._rows) {
            const row = new KeyRow(this);
            for (const def of rowDef) {
                if (def.type === 'gap') {
                    // Thumb mode: empty, non-reactive middle (touches reach the app).
                    const spacer = new St.Widget({reactive: false});
                    spacer.units = def.w;
                    row.add_child(spacer);
                    continue;
                }
                const key = new OskKey(def, this);
                row.add_child(key);
                this._keys.push(key);
                if (def.type === 'modifier')
                    (this._modifierKeys[def.modifier] ??= []).push(key); // split: two Shift keys
                if (def.enterPart)
                    enterParts.push(key);
            }
            this._rowsBox.add_child(row);
        }
        if (enterParts.length === 2) {
            enterParts[0].twin = enterParts[1];
            enterParts[1].twin = enterParts[0];
        }

        for (const k of this._keys)
            k.setHeight(this._keyHeight);
        this._updateModifierState();
        this.queue_relayout();
        if (emit)
            this.emit('layout-changed');
    }

    // ------------------------------------------------------------ sequence tracking

    _seqId(event) {
        const seq = event.get_event_sequence();
        return seq ? `t${seq.get_slot()}` : 'ptr';
    }

    _findTarget(actor) {
        if (!actor)
            return null;
        for (let a = actor; a && a !== this; a = a.get_parent()) {
            if (a === this._handle || a === this._resizeGrip)
                return null; // FloatingController owns these
            if (a._toskTarget)
                return a._toskTarget;
        }
        return this._noopTarget; // gaps between keys, footer, … (swipe still works)
    }

    _onCapturedEvent(event) {
        const T = Clutter.EventType;
        const type = event.type();
        const isTouch = type === T.TOUCH_BEGIN || type === T.TOUCH_UPDATE ||
            type === T.TOUCH_END || type === T.TOUCH_CANCEL;
        // On X11 touch is emulated as pointer events, which we handle instead.
        if (isTouch && !isWaylandCompositor())
            return Clutter.EVENT_PROPAGATE;

        switch (type) {
        case T.BUTTON_PRESS:
        case T.TOUCH_BEGIN: {
            const target = this._findTarget(global.stage.get_event_actor(event));
            if (!target)
                return Clutter.EVENT_PROPAGATE;
            if (type === T.BUTTON_PRESS && event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;
            const id = this._seqId(event);
            const old = this._seqs.get(id);
            if (old) {
                this._seqs.delete(id);
                this._cancelSeq(old);
            }
            const [x, y] = event.get_coords();
            const st = {
                id, target, x0: x, y0: y, x, y,
                candidate: false, swiping: false, fired: false,
            };
            this._seqs.set(id, st);
            target.down(st);
            return Clutter.EVENT_STOP;
        }
        case T.MOTION:
        case T.TOUCH_UPDATE: {
            const st = this._seqs.get(this._seqId(event));
            if (!st)
                return Clutter.EVENT_PROPAGATE;
            [st.x, st.y] = event.get_coords();
            this._trackSwipe(st);
            return Clutter.EVENT_STOP;
        }
        case T.BUTTON_RELEASE:
        case T.TOUCH_END: {
            const id = this._seqId(event);
            const st = this._seqs.get(id);
            if (!st)
                return Clutter.EVENT_PROPAGATE;
            if (type === T.BUTTON_RELEASE && event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;
            [st.x, st.y] = event.get_coords();
            this._seqs.delete(id);
            this._finishSeq(st);
            return Clutter.EVENT_STOP;
        }
        case T.TOUCH_CANCEL: {
            const id = this._seqId(event);
            const st = this._seqs.get(id);
            if (!st)
                return Clutter.EVENT_PROPAGATE;
            this._seqs.delete(id);
            this._cancelSeq(st);
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _trackSwipe(st) {
        if (st.swiping) {
            this.emit('swipe-progress', Math.max(0, st.y - st.y0));
            return;
        }
        if (!this._swipeEnabled())
            return;
        const kh = this._keyHeight;
        const dx = st.x - st.x0, dy = st.y - st.y0;
        const vertical = dy > 2 * Math.abs(dx);
        if (!st.candidate) {
            // Only a lone finger can swipe: a held modifier (or any other finger)
            // is never disturbed by another finger's motion, and vice versa.
            // A modifier that was already used for a chord does not swipe either.
            if (this._seqs.size !== 1 || st.noSwipe)
                return;
            if (!(dy > kh * SWIPE_SLOP && vertical))
                return;
            st.candidate = true;
        }
        this.emit('swipe-progress', Math.max(0, dy));
        if (dy > kh * SWIPE_TRIGGER && vertical) {
            st.swiping = true;
            st.target.cancel(st); // no output, repeat cancelled
        }
    }

    _finishSeq(st) {
        if (st.swiping) {
            if (st.y - st.y0 > this._keyHeight * SWIPE_COMMIT)
                this.emit('swipe-hide');
            else
                this.emit('swipe-cancel');
            return;
        }
        if (st.candidate)
            this.emit('swipe-cancel');
        st.target.up(st);
    }

    _cancelSeq(st) {
        if (st.candidate)
            this.emit('swipe-cancel');
        if (!st.swiping)
            st.target.cancel(st);
    }

    // ------------------------------------------------------------ key events

    _keyDown(key, st) {
        const def = key.def;
        key.setActive(true);
        if (def.type === 'modifier') {
            this._modDown(def.modifier, st);
            return;
        }
        if (def.type === 'hide')
            return;
        // Chording: modifiers held right now apply to this key even if they are
        // lifted before this key is released.
        if (this._held.size > 0) {
            st.heldSnapshot = new Set(this._held.keys());
            this._markHeldUsed();
        }
        this._withExtraMods(st, () => {
            // Shortcuts (Strg/Alt/Super) and Fn functions never auto-repeat: they may
            // open a modal shell UI that swallows our release event.
            if (def.repeat && !this._isCombo(def))
                this._startRepeat(key, st);
        });
    }

    _keyUp(key, st) {
        const def = key.def;
        key.setActive(false);
        if (this._repeatSt === st)
            this._stopRepeat();
        if (def.type === 'modifier') {
            this._modUp(def.modifier, st);
            return;
        }
        if (def.type === 'hide') {
            this.emit('hide-request');
            return;
        }
        if (!st.fired)
            this._activateKey(key, st);
        this._consumeOneShots();
    }

    _keyCancel(key, st) {
        key.setActive(false);
        if (this._repeatSt === st)
            this._stopRepeat();
        if (key.def.type === 'modifier') {
            this._modCancel(key.def.modifier, st);
            return;
        }
        if (st.fired)
            this._consumeOneShots();
    }

    _withExtraMods(st, fn) {
        const prev = this._extraMods;
        this._extraMods = st.heldSnapshot ?? null;
        try {
            return fn();
        } finally {
            this._extraMods = prev;
        }
    }

    _activateKey(key, st) {
        this._withExtraMods(st, () => {
            if (!st.def)
                st.def = this._resolveKey(key, st) ?? key.def;
            const combo = this._isCombo(st.def);
            this._markHeldUsed();
            this._activate(st.def);
            if (combo)
                this._consumeOneShots();
        });
    }

    _isCombo(def) {
        return this._shortcutModifiers().length > 0 ||
            (this._modActive('fn') && !!(def.fnKeysym || def.fnAction));
    }

    _resolveKey(key, st) {
        const def = key.def;
        if (!this._keyResolver || def.type !== 'char' || def.space || !def.letter)
            return null;
        if (['ctrl', 'alt', 'super', 'altgr', 'fn'].some(m => this._modActive(m)))
            return null;
        const candidates = [];
        for (const k of this._keys) {
            if (!k.def.letter || !k.mapped)
                continue;
            const [x, y] = k.get_transformed_position();
            const [w, h] = k.get_transformed_size();
            candidates.push({char: k.def.char, cx: x + w / 2, cy: y + h / 2, w, h});
        }
        let ch = null;
        try {
            ch = this._keyResolver({x: st.x0, y: st.y0}, candidates);
        } catch (e) {
            console.error(`[tablet-osk] key resolver: ${e}`);
            return null;
        }
        if (!ch || ch === def.char)
            return null;
        return this._keys.find(k => k.def.letter && k.def.char === ch)?.def ?? null;
    }

    _startRepeat(key, st) {
        this._stopRepeat();
        this._repeatSt = st;
        this._repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_DELAY_MS, () => {
            // First output after the hold delay; the release will then not fire again.
            st.fired = true;
            this._activateKey(key, st);
            this._repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_INTERVAL_MS, () => {
                // Stop if the key is gone or someone else grabbed the input (modal UI):
                // then we will never see the release event.
                const grab = global.stage.get_grab_actor();
                if (!key.mapped || (grab && !this.contains(grab)) ||
                    this._withExtraMods(st, () => this._isCombo(st.def ?? key.def))) {
                    this._repeatId = 0;
                    this._repeatSt = null;
                    return GLib.SOURCE_REMOVE;
                }
                this._activateKey(key, st);
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopRepeat() {
        if (this._repeatId) {
            GLib.source_remove(this._repeatId);
            this._repeatId = 0;
        }
        this._repeatSt = null;
    }

    // ------------------------------------------------------------ modifiers
    // With 'modifier-hold-release' (default): a modifier is active while its key is
    // held. On release it is just released if another key was activated meanwhile or
    // it was held longer than 'modifier-hold-ms'; otherwise (short tap) the usual
    // latch semantics apply (Shift: one-shot, double tap = lock; others: one-shot latch).

    _modDown(mod, st) {
        st.modT0 = nowMs();
        if (mod === 'caps')
            return;
        if (this._holdEnabled()) {
            this._held.set(mod, {t0: st.modT0, used: false});
            this._updateModifierState();
            return;
        }
        if (mod === 'super')
            this._superPressLegacy(st);
    }

    _modUp(mod, st) {
        const elapsed = nowMs() - (st.modT0 ?? nowMs());
        if (mod === 'caps') {
            // OSK-internal caps lock (no real Caps_Lock, because the keysym fallback
            // path would otherwise invert the case twice).
            this._caps = !this._caps;
            this._updateModifierState();
            return;
        }
        const h = this._held.get(mod);
        this._held.delete(mod);
        if (mod === 'super') {
            if (h)
                this._superUp(h, elapsed);
            else
                this._superReleaseLegacy(st);
        } else if (h && (h.used || elapsed > this._holdMs())) {
            // Used for a chord or held long: release, don't latch (a Shift lock stays).
            if (mod === 'shift') {
                if (this._shift === 1)
                    this._shift = 0;
            } else {
                this._latched.delete(mod);
            }
        } else {
            this._toggleModifier(mod);
        }
        this._updateModifierState();
    }

    _modCancel(mod, st) {
        this._held.delete(mod);
        if (mod === 'super' && st.superTimer)
            this._clearSuperTimer();
        this._updateModifierState();
    }

    _markHeldUsed() {
        for (const h of this._held.values())
            h.used = true;
        // A modifier that is part of a chord must not turn into a swipe.
        for (const st of this._seqs.values()) {
            if (st.modT0 !== undefined)
                st.noSwipe = true;
        }
    }

    // ---- Super / Start key
    // Short tap (< SUPER_LONG_PRESS_MS, nothing else pressed): overview toggle, double
    // tap: app grid. Held together with another key: Super+key combo. Held
    // SUPER_LONG_PRESS_MS..hold-ms and released alone: latched for the next key (mouse
    // users). Held longer: released on lift. Tapping a latched Super unlatches it.

    _superUp(h, elapsed) {
        if (h.used) {
            this._latched.delete('super');
        } else if (elapsed < SUPER_LONG_PRESS_MS) {
            if (this._latched.has('super'))
                this._latched.delete('super');
            else
                this._superTap();
        } else if (elapsed <= this._holdMs()) {
            this._latched.add('super');
        } else {
            this._latched.delete('super');
        }
    }

    // modifier-hold-release off: old behaviour (long press latches via timer).
    _superPressLegacy(st) {
        this._clearSuperTimer();
        if (this._latched.has('super')) {
            st.superUnlatch = true;
            return;
        }
        st.superTimer = true;
        this._superTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUPER_LONG_PRESS_MS, () => {
            this._superTimerId = 0;
            st.superLatched = true;
            this._latched.add('super');
            this._updateModifierState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _superReleaseLegacy(st) {
        this._clearSuperTimer();
        if (st.superUnlatch)
            this._latched.delete('super');
        else if (!st.superLatched)
            this._superTap();
    }

    _superTap() {
        const now = nowMs();
        const double = now - (this._lastSuperTap ?? 0) < SUPER_DOUBLE_TAP_MS;
        this._lastSuperTap = double ? 0 : now;
        this._consumeOneShots();
        try {
            if (double && Main.overview.visible)
                Main.overview.dash.showAppsButton.checked = true; // showApps() is a no-op while shown
            else if (double)
                Main.overview.showApps();
            else
                Main.overview.toggle();
        } catch (e) {
            console.error(`[tablet-osk] overview: ${e}`);
        }
    }

    _clearSuperTimer() {
        if (this._superTimerId) {
            GLib.source_remove(this._superTimerId);
            this._superTimerId = 0;
        }
    }

    _toggleModifier(mod) {
        if (mod === 'shift') {
            const now = nowMs();
            if (this._shift === 2)
                this._shift = 0;
            else if (this._shift === 1 && now - this._lastShiftTap < SHIFT_DOUBLE_TAP_MS)
                this._shift = 2;
            else if (this._shift === 1)
                this._shift = 0;
            else
                this._shift = 1;
            this._lastShiftTap = now;
        } else if (this._latched.has(mod)) {
            this._latched.delete(mod);
        } else {
            this._latched.add(mod);
        }
    }

    _modActive(mod) {
        if (this._held.has(mod) || this._extraMods?.has(mod))
            return true;
        return mod === 'shift' ? this._shift > 0 : this._latched.has(mod);
    }

    _consumeOneShots() {
        let changed = false;
        if (this._shift === 1) {
            this._shift = 0;
            changed = true;
        }
        if (this._latched.size > 0) {
            this._latched.clear();
            changed = true;
        }
        if (changed)
            this._updateModifierState();
    }

    _updateModifierState() {
        const mk = this._modifierKeys ?? {};
        const latch = (m, ...args) => mk[m]?.forEach(k => k.setLatched(...args));
        latch('shift', this._shift === 1 || this._held.has('shift'), this._shift === 2);
        latch('caps', false, this._caps);
        for (const m of LATCH_MODIFIERS)
            latch(m, this._latched.has(m) || this._held.has(m));
        const fnOn = this._latched.has('fn') || this._held.has('fn');
        if (fnOn)
            this.add_style_class_name('tosk-fn-on');
        else
            this.remove_style_class_name('tosk-fn-on');
        const shiftOn = this._shift > 0 || this._held.has('shift');
        const altgrOn = this._latched.has('altgr') || this._held.has('altgr');
        for (const k of this._keys)
            k.setLevel(shiftOn, altgrOn);
    }

    _shortcutModifiers() {
        const mods = [];
        if (this._modActive('ctrl'))
            mods.push(Clutter.KEY_Control_L);
        if (this._modActive('alt'))
            mods.push(Clutter.KEY_Alt_L);
        if (this._modActive('super'))
            mods.push(Clutter.KEY_Super_L);
        return mods;
    }

    // ------------------------------------------------------------ output

    _activate(def) {
        if (!this._injector)
            return;
        const mods = this._shortcutModifiers();
        const shift = this._modActive('shift');
        const withShift = shift ? [Clutter.KEY_Shift_L, ...mods] : mods;

        if (this._modActive('fn') && def.fnAction === 'settings') {
            this.emit('settings-request');
            return;
        }

        if (this._modActive('fn') && def.fnKeysym) {
            this._injector.tap(resolveKeyval(def.fnKeysym), withShift);
            if (mods.length === 0)
                this.emit('key-sent', def.fnKeysym);
            return;
        }

        if (def.type === 'char') {
            const altgr = this._modActive('altgr') && def.altgrChar;
            if (mods.length > 0) {
                // Shortcut: send the base keysym (lowercase letters) + modifiers.
                if (def.space) {
                    this._injector.tap(Clutter.KEY_space, withShift);
                } else if (altgr) {
                    this._injector.typeChar(def.altgrChar, mods);
                } else {
                    const c = def.letter ? def.char.toLowerCase() : def.char;
                    this._injector.typeChar(c, withShift);
                }
                // Let listeners (prediction) know the text/selection may have changed (Strg+A, Strg+V …).
                this.emit('key-sent', 'shortcut');
                return;
            }
            const str = this._charFor(def);
            this._pendingText = '';
            if (this._charFilter) {
                this._inCharFilter = true;
                try {
                    this._charFilter(str);
                } catch (e) {
                    console.error(`[tablet-osk] char filter: ${e}`);
                } finally {
                    this._inCharFilter = false;
                }
            }
            if (!this._injector)
                return;
            this._injector.typeChar(this._pendingText + str, []);
            this._pendingText = '';
            this.emit('text-typed', str);
            return;
        }

        // special / enter
        if (def.keysym === 'BackSpace' && mods.length === 0 && !shift && this._backspaceFilter) {
            let handled = false;
            try {
                handled = this._backspaceFilter();
            } catch (e) {
                console.error(`[tablet-osk] backspace filter: ${e}`);
            }
            if (handled)
                return;
        }
        const keyval = resolveKeyval(def.keysym);
        if (keyval) {
            this._injector.tap(keyval, withShift);
            if (mods.length === 0)
                this.emit('key-sent', def.keysym);
        }
    }

    _charFor(def) {
        if (this._modActive('altgr') && def.altgrChar)
            return def.altgrChar;
        const shift = this._modActive('shift');
        if (def.letter)
            return shift !== this._caps ? def.shiftChar : def.char;
        return shift ? def.shiftChar ?? def.char : def.char;
    }

    // ------------------------------------------------------------ teardown

    _onDestroy() {
        Main.overview.disconnectObject(this);
        Main.screenshotUI?.disconnectObject(this);
        this._stopRepeat();
        this._clearSuperTimer();
        this._seqs.clear();
        this._held.clear();
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._charFilter = null;
        this._keyResolver = null;
        this._injector?.destroy();
        this._injector = null;
        this._keys = [];
    }
});
