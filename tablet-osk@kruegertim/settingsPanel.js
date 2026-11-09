// Touch-optimised in-keyboard settings panel (overlay on top of the keys).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const KEY_HEIGHT_MIN = 7.0;
const KEY_HEIGHT_MAX = 20.0;
const KEY_HEIGHT_STEP = 0.5;
const OPACITY_MIN = 0.3;
const OPACITY_MAX = 1.0;
const DOCKED_WIDTH_MIN = 0.5;
const KEY_HEIGHT_DEBOUNCE_MS = 150;
const OPACITY_THROTTLE_MS = 60;
const BRIGHTNESS_MIN = 0.65;
const BRIGHTNESS_MAX = 1.0;
const MIN_ROW_MM = 9;
const GLOW_W_MIN = 1;
const GLOW_W_MAX = 6;
const FLASH_MAX_MS = 1000;
const FLASH_STEP_MS = 50;
const HOLD_MIN_MS = 300;
const HOLD_MAX_MS = 2000;
const TOUCH_SCROLL_SLOP_PX = 12; // vertical finger travel before the panel scrolls
const HOLD_STEP_MS = 100;
const HOLD_DEBOUNCE_MS = 150;
const CLEAR_CONFIRM_MS = 3000;
const MIN_ROW_PX = 48;

function formatMm(mm) {
    return `${mm.toFixed(1).replace('.', ',')} mm`;
}

function formatFlash(ms) {
    return ms <= 0 ? 'Aus' : `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
}

function formatGlow(v) {
    return v <= 0.001 ? 'Aus' : formatPercent(v);
}

function formatPercent(v) {
    return `${Math.round(v * 100)} %`;
}

function formatSeconds(ms) {
    return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

function snapHoldMs(ms) {
    const v = Math.round(ms / HOLD_STEP_MS) * HOLD_STEP_MS;
    return Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, v));
}

function snapKeyHeight(mm) {
    const v = Math.round(mm / KEY_HEIGHT_STEP) * KEY_HEIGHT_STEP;
    return Math.min(KEY_HEIGHT_MAX, Math.max(KEY_HEIGHT_MIN, v));
}

/** Small helper that delays/coalesces GSettings writes. */
class DelayedWriter {
    constructor(delayMs, write, {throttle = false} = {}) {
        this._delay = delayMs;
        this._write = write;
        this._throttle = throttle;
        this._id = 0;
        this._pending = null;
    }

    schedule(value) {
        this._pending = value;
        if (this._id && !this._throttle) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
        if (!this._id) {
            this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._delay, () => {
                this._id = 0;
                this.flush();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    flush() {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
        if (this._pending !== null) {
            const v = this._pending;
            this._pending = null;
            this._write(v);
        }
    }

    cancel() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
        this._pending = null;
    }
}

export const SettingsPanel = GObject.registerClass({
    Signals: {'close-request': {}},
}, class SettingsPanel extends St.BoxLayout {
    _init({settings, pxPerMm}) {
        super._init({
            vertical: true,
            style_class: 'tosk-settings-panel',
            reactive: true,
            can_focus: false,
            x_expand: true,
            y_expand: true,
        });

        this._settings = settings;
        this._pxPerMm = pxPerMm ?? (() => 96 / 25.4);
        this._syncing = false;
        this._scaled = []; // [widget, (m) => css] pairs re-evaluated on scale change
        this._metrics = null;
        this._columns = 0;
        this._reflowId = 0;

        this._khWriter = new DelayedWriter(KEY_HEIGHT_DEBOUNCE_MS,
            mm => this._settings.set_double(this._khKey(), mm));
        this._opWriter = new DelayedWriter(OPACITY_THROTTLE_MS,
            v => this._settings.set_double('floating-opacity', v), {throttle: true});
        this._dwWriter = new DelayedWriter(OPACITY_THROTTLE_MS,
            v => this._settings.set_double('docked-width', v), {throttle: true});
        this._brWriter = new DelayedWriter(OPACITY_THROTTLE_MS,
            v => this._settings.set_double('label-brightness', v), {throttle: true});
        this._glowWriter = new DelayedWriter(OPACITY_THROTTLE_MS,
            v => this._settings.set_double('key-glow', v), {throttle: true});
        this._glowWWriter = new DelayedWriter(OPACITY_THROTTLE_MS,
            px => this._settings.set_int('key-glow-width', px), {throttle: true});
        this._flashWriter = new DelayedWriter(OPACITY_THROTTLE_MS,
            ms => this._settings.set_int('press-flash-ms', ms), {throttle: true});
        this._holdWriter = new DelayedWriter(HOLD_DEBOUNCE_MS,
            ms => this._settings.set_int('modifier-hold-ms', ms));
        this._clearConfirmId = 0;

        this._scale(this, m => `font-size: ${m.font}px; padding: ${m.gap}px; spacing: ${m.gap}px;`);

        this._buildHeader();
        this._buildRows();

        // Swallow presses on the panel background so they never reach the chrome below.
        // Only events whose source is the panel itself: on GNOME 49+ St.Button/Slider use
        // Clutter.ClickGesture, which is cancelled when an ancestor stops the bubbling
        // events of its sequence (taps on buttons would never emit 'clicked').
        for (const sig of ['button-press-event', 'button-release-event', 'touch-event']) {
            this.connect(sig, (_a, event) => global.stage.get_event_actor(event) === this
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        }

        this._settings.connectObject(
            'changed::key-height-mm', () => this._syncKeyHeight(),
            'changed::thumb-key-height-mm', () => this._syncKeyHeight(),
            'changed::mode', () => this._syncMode(),
            'changed::show-f-row', () => this._syncSwitch(this._fRowSwitch, 'show-f-row'),
            'changed::layout', () => this._syncLayout(),
            'changed::layout-style', () => this._syncLayout(),
            'changed::auto-capitalize', () => this._syncSwitch(this._autoCapSwitch, 'auto-capitalize'),
            'changed::shrink-workarea', () => this._syncSwitch(this._shrinkSwitch, 'shrink-workarea'),
            'changed::auto-show', () => this._syncSwitch(this._autoSwitch, 'auto-show'),
            'changed::hide-after-submit', () => this._syncSwitch(this._submitSwitch, 'hide-after-submit'),
            'changed::move-dock-left', () => this._syncSwitch(this._dockSwitch, 'move-dock-left'),
            'changed::keep-key-aspect', () => this._syncSwitch(this._aspectSwitch, 'keep-key-aspect'),
            'changed::floating-opacity', () => this._syncOpacity(),
            'changed::docked-width', () => this._syncDockedWidth(),
            'changed::keyboard-position', () => this._posSeg.setActive(this._settings.get_string('keyboard-position')),
            'changed::label-brightness', () => this._syncBrightness(),
            'changed::key-glow', () => this._syncGlow(),
            'changed::key-glow-width', () => this._syncGlowWidth(),
            'changed::press-flash-ms', () => this._syncFlash(),
            'changed::suggestion-bar-position',
            () => this._barPosSeg.setActive(this._settings.get_string('suggestion-bar-position')),
            'changed::super-symbol', () => this._superSeg.setActive(this._settings.get_string('super-symbol')),
            'changed::letter-case', () => this._caseSeg.setActive(this._settings.get_string('letter-case')),
            'changed::modifier-hold-release', () => this._syncHoldRelease(),
            'changed::modifier-hold-ms', () => this._syncHoldMs(),
            'changed::suggestions', () => this._syncSwitch(this._suggestSwitch, 'suggestions'),
            'changed::autocorrect', () => this._syncSwitch(this._autocorrectSwitch, 'autocorrect'),
            'changed::dynamic-hitareas', () => this._syncSwitch(this._hitSwitch, 'dynamic-hitareas'),
            'changed::prediction-language', () => this._langSeg.setActive(this._settings.get_string('prediction-language')),
            this);

        this.connect('notify::mapped', () => {
            if (this.mapped)
                this.refreshScale();
        });
        this.connect('notify::width', () => this._queueReflow());
        this.connect('destroy', () => this._onDestroy());

        this._syncAll();
        this.refreshScale();
    }

    /** Re-read pxPerMm() and re-apply sizes (called automatically when the panel is mapped). */
    refreshScale() {
        // Styles can only be resolved once we are on the stage; 'notify::mapped' calls us again.
        if (!this.get_stage())
            return;
        let ppm = 0;
        try {
            ppm = Number(this._pxPerMm()) || 0;
        } catch (e) {
            ppm = 0;
        }
        if (ppm <= 0)
            ppm = 96 / 25.4;
        const row = Math.max(Math.round(MIN_ROW_MM * ppm), MIN_ROW_PX);
        const m = {
            row,
            font: Math.max(14, Math.round(row * 0.34)),
            gap: Math.round(row * 0.15),
            pad: Math.round(row * 0.3),
            radius: Math.round(row * 0.2),
        };
        this._metrics = m;
        for (const [w, fn] of this._scaled)
            w.set_style(fn(m));
        this._columns = 0;
        this._reflow();
    }

    // ---- construction -------------------------------------------------------------------

    _scale(widget, fn) {
        this._scaled.push([widget, fn]);
        return widget;
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'tosk-settings-header', x_expand: true});
        this._scale(header, m => `spacing: ${m.gap}px; padding: 0 ${m.gap}px;`);
        header.add_child(new St.Label({
            text: 'Tastatur-Einstellungen',
            style_class: 'tosk-settings-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const done = new St.Button({
            label: 'Fertig',
            style_class: 'tosk-settings-done',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._scale(done, m =>
            `min-height: ${Math.round(m.row * 0.85)}px; min-width: ${Math.round(m.row * 2.4)}px; ` +
            `padding: 0 ${m.pad}px; border-radius: ${m.radius}px;`);
        done.connect('clicked', () => {
            this._flushWrites();
            this.emit('close-request');
        });
        header.add_child(done);
        this.add_child(header);
    }

    _buildRows() {
        const r = {};

        // Tastenhöhe
        {
            const {row, valueLabel, slider} = this._sliderRow('Tastenhöhe', {
                minus: () => this._stepKeyHeight(-KEY_HEIGHT_STEP),
                plus: () => this._stepKeyHeight(KEY_HEIGHT_STEP),
            });
            this._khLabel = valueLabel;
            this._khSlider = slider;
            this._khDragging = false;
            slider.connect('drag-begin', () => {
                this._khDragging = true;
            });
            slider.connect('drag-end', () => {
                this._khDragging = false;
                this._khWriter.schedule(this._khValue());
                this._khWriter.flush();
            });
            slider.connect('notify::value', () => {
                const mm = this._khValue();
                this._khLabel.text = formatMm(mm);
                if (this._syncing)
                    return;
                if (this._khDragging)
                    this._khWriter.cancel(); // written on release
                else
                    this._khWriter.schedule(mm);
            });
            r.keyHeight = row;
        }

        // Modus
        {
            const seg = this._segmented([['docked', 'Angedockt'], ['floating', 'Schwebend'], ['thumb', 'Daumen']],
                id => this._settings.set_string('mode', id));
            this._modeSeg = seg;
            r.mode = this._row('Modus', seg.actor);
        }

        // F-Reihe
        this._fRowSwitch = this._switch('show-f-row');
        r.fRow = this._row('F-Reihe', this._fRowSwitch);

        // Layout
        {
            const seg = this._segmented([['qwertz', 'QWERTZ'], ['qwerty', 'QWERTY']],
                id => this._settings.set_string('layout', id));
            this._layoutSeg = seg;
            r.layout = this._row('Layout', seg.actor);
        }

        // Tastenanordnung: klassisch (ThinkPad) oder Touch (Windows-11-artig)
        {
            const seg = this._segmented([['classic', 'Klassisch'], ['touch', 'Touch']],
                id => this._settings.set_string('layout-style', id));
            this._styleSeg = seg;
            r.style = this._row('Anordnung', seg.actor);
        }

        // Satzanfang groß (nur Touch)
        this._autoCapSwitch = this._switch('auto-capitalize');
        r.autoCap = this._row('Satzanfang groß', this._autoCapSwitch);

        // Inhalt verkleinern
        this._shrinkSwitch = this._switch('shrink-workarea');
        r.shrink = this._row('Inhalt verkleinern', this._shrinkSwitch);

        // Automatisch einblenden
        this._autoSwitch = this._switch('auto-show');
        r.auto = this._row('Automatisch einblenden', this._autoSwitch);

        // Nach dem Absenden ausblenden
        this._submitSwitch = this._switch('hide-after-submit');
        r.submit = this._row('Nach dem Absenden ausblenden', this._submitSwitch);

        // Dock nach links
        this._dockSwitch = this._switch('move-dock-left');
        r.dock = this._row('Dock nach links verschieben', this._dockSwitch);

        // Proportionen beibehalten (unter 13 mm schmalere Tastatur statt flacherer Tasten)
        this._aspectSwitch = this._switch('keep-key-aspect');
        r.aspect = this._row('Proportionen beibehalten', this._aspectSwitch);

        // Position: unten / oben (angedockt und Daumen)
        {
            const seg = this._segmented([['bottom', 'Unten'], ['top', 'Oben']],
                id => this._settings.set_string('keyboard-position', id));
            this._posSeg = seg;
            r.position = this._row('Position', seg.actor);
        }

        // Breite (angedockt)
        {
            const {row, valueLabel, slider} = this._sliderRow('Breite (angedockt)', null);
            this._dwLabel = valueLabel;
            this._dwSlider = slider;
            slider.connect('drag-end', () => this._dwWriter.flush());
            slider.connect('notify::value', () => {
                const v = this._dwValue();
                this._dwLabel.text = formatPercent(v);
                if (!this._syncing)
                    this._dwWriter.schedule(v);
            });
            r.dockedWidth = row;
        }

        // Deckkraft
        {
            const {row, valueLabel, slider} = this._sliderRow('Deckkraft', null);
            this._opLabel = valueLabel;
            this._opSlider = slider;
            slider.connect('drag-end', () => this._opWriter.flush());
            slider.connect('notify::value', () => {
                const v = this._opValue();
                this._opLabel.text = formatPercent(v);
                if (!this._syncing)
                    this._opWriter.schedule(v);
            });
            r.opacity = row;
        }

        // Helligkeit der Beschriftung
        {
            const {row, valueLabel, slider} = this._sliderRow('Helligkeit der Beschriftung', null);
            this._brLabel = valueLabel;
            this._brSlider = slider;
            slider.connect('drag-end', () => this._brWriter.flush());
            slider.connect('notify::value', () => {
                const v = this._brValue();
                this._brLabel.text = formatPercent(v);
                if (!this._syncing)
                    this._brWriter.schedule(v);
            });
            r.brightness = row;
        }

        // Leuchtrand der Tasten (0 % = aus)
        {
            const {row, valueLabel, slider} = this._sliderRow('Leuchtrand der Tasten', null);
            this._glowLabel = valueLabel;
            this._glowSlider = slider;
            slider.connect('drag-end', () => this._glowWriter.flush());
            slider.connect('notify::value', () => {
                const v = this._glowValue();
                this._glowLabel.text = formatGlow(v);
                if (!this._syncing)
                    this._glowWriter.schedule(v);
            });
            r.glow = row;
        }

        // Breite des Leuchtrands (px)
        {
            const {row, valueLabel, slider} = this._sliderRow('Breite des Leuchtrands', null);
            this._glowWLabel = valueLabel;
            this._glowWSlider = slider;
            slider.connect('drag-end', () => this._glowWWriter.flush());
            slider.connect('notify::value', () => {
                const px = this._glowWidthValue();
                this._glowWLabel.text = `${px} px`;
                if (!this._syncing)
                    this._glowWWriter.schedule(px);
            });
            r.glowWidth = row;
        }

        // Aufleuchten beim Drücken (Dauer, 0 = aus)
        {
            const {row, valueLabel, slider} = this._sliderRow('Aufleuchten beim Drücken', null);
            this._flashLabel = valueLabel;
            this._flashSlider = slider;
            slider.connect('drag-end', () => this._flashWriter.flush());
            slider.connect('notify::value', () => {
                const ms = this._flashValue();
                this._flashLabel.text = formatFlash(ms);
                if (!this._syncing)
                    this._flashWriter.schedule(ms);
            });
            r.flash = row;
        }

        // Beschriftung der Buchstabentasten
        {
            const seg = this._segmented([['upper', 'Immer groß'], ['shift', 'Nur mit Shift']],
                id => this._settings.set_string('letter-case', id), {minRows: 1.6});
            this._caseSeg = seg;
            r.letterCase = this._row('Großbuchstaben', seg.actor);
        }

        // Symbol der Super-Taste
        {
            const seg = this._segmented([['fish', 'Fisch'], ['tux', 'Tux'], ['diamond', 'Raute'], ['text', 'Super']],
                id => this._settings.set_string('super-symbol', id), {minRows: 1.6});
            this._superSeg = seg;
            r.superSym = this._row('Super-Taste', seg.actor);
        }

        // Gehaltene Umschalttasten beim Loslassen lösen
        this._holdSwitch = this._switch('modifier-hold-release');
        r.holdRelease = this._row('Gehaltene Umschalttasten lösen', this._holdSwitch);

        // Haltedauer
        {
            const {row, valueLabel, slider} = this._sliderRow('Haltedauer', null);
            this._holdLabel = valueLabel;
            this._holdSlider = slider;
            slider.connect('drag-end', () => this._holdWriter.flush());
            slider.connect('notify::value', () => {
                const ms = this._holdValue();
                this._holdLabel.text = formatSeconds(ms);
                if (!this._syncing)
                    this._holdWriter.schedule(ms);
            });
            r.holdMs = row;
        }

        // --- Vorhersage ---
        r.predictHeader = this._sectionLabel('Vorhersage');

        this._suggestSwitch = this._switch('suggestions');
        r.suggest = this._row('Vorschläge', this._suggestSwitch);

        {
            const seg = this._segmented([['top', 'Oben'], ['bottom', 'Unten']],
                id => this._settings.set_string('suggestion-bar-position', id), {minRows: 1.6});
            this._barPosSeg = seg;
            r.barPos = this._row('Position der Vorschlagsleiste', seg.actor);
        }

        this._autocorrectSwitch = this._switch('autocorrect');
        r.autocorrect = this._row('Autokorrektur', this._autocorrectSwitch);

        this._hitSwitch = this._switch('dynamic-hitareas');
        r.hitareas = this._row('Dynamische Trefferflächen', this._hitSwitch);

        {
            const seg = this._segmented([['auto', 'Auto'], ['de', 'Deutsch'], ['en', 'Englisch']],
                id => this._settings.set_string('prediction-language', id), {minRows: 1.6});
            this._langSeg = seg;
            r.language = this._row('Sprache', seg.actor);
        }

        {
            const b = new St.Button({
                label: 'Löschen',
                style_class: 'tosk-settings-step',
                can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._scale(b, m =>
                `min-height: ${Math.round(m.row * 0.72)}px; min-width: ${Math.round(m.row * 2.6)}px; ` +
                `padding: 0 ${m.pad}px; border-radius: ${m.radius}px;`);
            b.connect('clicked', () => this._onClearClicked());
            this._clearButton = b;
            r.clearDict = this._row('Gelerntes Wörterbuch löschen', b);
        }

        this._rows = r;
        // single-column order (contract order) and two-column order (left | right)
        this._order1 = [r.keyHeight, r.aspect, r.mode, r.style, r.fRow, r.layout, r.autoCap, r.position, r.dockedWidth, r.shrink, r.auto, r.submit,
            r.dock, r.opacity, r.brightness, r.glow, r.glowWidth, r.flash, r.letterCase, r.superSym, r.holdRelease,
            r.holdMs, r.predictHeader, r.suggest, r.barPos, r.autocorrect, r.hitareas, r.language, r.clearDict];
        this._order2 = [
            [r.keyHeight, r.aspect, r.layout, r.fRow, r.brightness, r.glow, r.glowWidth, r.flash,
                r.letterCase, r.auto, r.submit, r.superSym, r.holdRelease,
                r.holdMs],
            [r.mode, r.style, r.autoCap, r.position, r.dockedWidth, r.shrink, r.opacity, r.dock,
                r.predictHeader, r.suggest, r.barPos, r.autocorrect, r.hitareas, r.language, r.clearDict],
        ];

        this._colA = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tosk-settings-column'});
        this._colB = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tosk-settings-column'});
        this._scale(this._colA, m => `spacing: ${m.gap}px;`);
        this._scale(this._colB, m => `spacing: ${m.gap}px;`);
        const columns = new St.BoxLayout({x_expand: true, style_class: 'tosk-settings-columns'});
        this._scale(columns, m => `spacing: ${m.gap}px;`);
        columns.add_child(this._colA);
        columns.add_child(this._colB);

        this._scrollView = new St.ScrollView({
            style_class: 'tosk-settings-scroll',
            x_expand: true,
            y_expand: true,
            can_focus: false,
            reactive: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: columns,
        });
        this.add_child(this._scrollView);
        this._enableTouchScroll(this._scrollView);
    }

    // St.ScrollView has no touch panning in GNOME Shell: without this, rows below the
    // fold are unreachable on a touchscreen. A vertical drag (one finger) scrolls; the
    // control under the finger is released once the drag starts.
    _enableTouchScroll(view) {
        const T = Clutter.EventType;
        let slot = null, y0 = 0, v0 = 0, dragging = false, pressed = null;
        view.connect('captured-event', (_a, event) => {
            const type = event.type();
            if (type !== T.TOUCH_BEGIN && type !== T.TOUCH_UPDATE &&
                type !== T.TOUCH_END && type !== T.TOUCH_CANCEL)
                return Clutter.EVENT_PROPAGATE;
            const evSlot = event.get_event_sequence()?.get_slot() ?? -1;
            const [, y] = event.get_coords();
            const adj = view.vadjustment;

            if (type === T.TOUCH_BEGIN) {
                if (slot === null) {
                    slot = evSlot;
                    y0 = y;
                    v0 = adj.value;
                    dragging = false;
                    pressed = null;
                    for (let a = global.stage.get_event_actor(event); a && a !== view; a = a.get_parent()) {
                        if (a instanceof St.Button) {
                            pressed = a;
                            break;
                        }
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }
            if (evSlot !== slot)
                return Clutter.EVENT_PROPAGATE;

            if (type === T.TOUCH_UPDATE) {
                if (!dragging && Math.abs(y - y0) > TOUCH_SCROLL_SLOP_PX &&
                    adj.upper - adj.page_size > 0) {
                    dragging = true;
                    pressed?.fake_release?.();
                }
                if (!dragging)
                    return Clutter.EVENT_PROPAGATE;
                adj.value = Math.max(adj.lower,
                    Math.min(adj.upper - adj.page_size, v0 - (y - y0)));
                return Clutter.EVENT_STOP;
            }

            // TOUCH_END / TOUCH_CANCEL
            const wasDragging = dragging;
            slot = null;
            dragging = false;
            pressed = null;
            return wasDragging ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });
    }

    _row(title, control) {
        const row = new St.BoxLayout({
            style_class: 'tosk-settings-row',
            x_expand: true,
            reactive: true,
        });
        this._scale(row, m =>
            `min-height: ${m.row}px; padding: 0 ${m.pad}px; spacing: ${m.gap}px; border-radius: ${m.radius}px;`);
        row.add_child(new St.Label({
            text: title,
            style_class: 'tosk-settings-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        control.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(control);
        return row;
    }

    _sectionLabel(text) {
        const label = new St.Label({
            text,
            style_class: 'tosk-settings-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._scale(label, m => `padding: ${Math.round(m.gap * 1.5)}px ${m.pad}px 0 ${m.pad}px;`);
        return label;
    }

    _onClearClicked() {
        const b = this._clearButton;
        if (this._clearDone)
            return; // 'Gelöscht' feedback phase
        if (!this._clearConfirmId) {
            // first tap: ask for confirmation for 3 s
            b.label = 'Wirklich löschen?';
            b.remove_style_class_name('tosk-settings-step');
            b.add_style_class_name('tosk-settings-done');
            this._clearConfirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLEAR_CONFIRM_MS, () => {
                this._clearConfirmId = 0;
                this._resetClearButton();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        GLib.source_remove(this._clearConfirmId);
        this._clearConfirmId = 0;
        const s = this._settings;
        s.set_int('clear-userdict-request', (s.get_int('clear-userdict-request') + 1) % 1000000);
        b.label = 'Gelöscht';
        b.remove_style_class_name('tosk-settings-done');
        b.add_style_class_name('tosk-settings-step');
        this._clearConfirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._clearConfirmId = 0;
            this._resetClearButton();
            return GLib.SOURCE_REMOVE;
        });
        // the 'Gelöscht' phase must not count as the confirm state
        this._clearDone = true;
    }

    _resetClearButton() {
        this._clearDone = false;
        const b = this._clearButton;
        if (!b)
            return;
        b.label = 'Löschen';
        b.remove_style_class_name('tosk-settings-done');
        b.add_style_class_name('tosk-settings-step');
    }

    _sliderRow(title, steps) {
        const row = new St.BoxLayout({
            style_class: 'tosk-settings-row',
            x_expand: true,
            reactive: true,
        });
        this._scale(row, m =>
            `min-height: ${m.row}px; padding: 0 ${m.pad}px; spacing: ${m.gap}px; border-radius: ${m.radius}px;`);
        const label = new St.Label({
            text: title,
            style_class: 'tosk-settings-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(label);
        const valueLabel = new St.Label({
            style_class: 'tosk-settings-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._scale(valueLabel, m => `min-width: ${Math.round(m.font * 3.6)}px;`);
        row.add_child(valueLabel);

        const slider = new Slider.Slider(0);
        slider.can_focus = false;
        slider.add_style_class_name('tosk-settings-slider');
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        this._scale(slider, m =>
            `-slider-handle-radius: ${Math.round(m.row * 0.2)}px; ` +
            `-barlevel-height: ${Math.max(4, Math.round(m.row * 0.1))}px; ` +
            `min-width: ${Math.round(m.row * 2.5)}px; min-height: ${Math.round(m.row * 0.7)}px;`);

        if (steps) {
            row.add_child(this._roundButton('−', steps.minus));
            row.add_child(slider);
            row.add_child(this._roundButton('+', steps.plus));
        } else {
            row.add_child(slider);
        }
        return {row, valueLabel, slider};
    }

    _roundButton(text, onClick) {
        const b = new St.Button({
            label: text,
            style_class: 'tosk-settings-step',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._scale(b, m => {
            const s = Math.round(m.row * 0.8);
            return `width: ${s}px; height: ${s}px; border-radius: ${Math.round(s / 2)}px; ` +
                `font-size: ${Math.round(m.font * 1.3)}px;`;
        });
        b.connect('clicked', onClick);
        return b;
    }

    _switch(key) {
        const knob = new St.Widget({
            style_class: 'tosk-settings-switch-knob',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const sw = new St.Button({
            style_class: 'tosk-settings-switch',
            toggle_mode: true,
            can_focus: false,
            child: knob,
        });
        this._scale(sw, m => {
            const h = Math.round(m.row * 0.66);
            const p = Math.max(3, Math.round(h * 0.1));
            return `width: ${Math.round(h * 1.85)}px; height: ${h}px; border-radius: ${Math.round(h / 2)}px; ` +
                `padding: ${p}px;`;
        });
        this._scale(knob, m => {
            const h = Math.round(m.row * 0.66);
            const p = Math.max(3, Math.round(h * 0.1));
            const k = h - 2 * p;
            return `width: ${k}px; height: ${k}px; border-radius: ${Math.round(k / 2)}px;`;
        });
        sw.connect('notify::checked', () => {
            knob.x_align = sw.checked ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
            if (!this._syncing && this._settings.get_boolean(key) !== sw.checked)
                this._settings.set_boolean(key, sw.checked);
        });
        sw._toskKnob = knob;
        return sw;
    }

    _segmented(items, onSelect, {minRows = 2.1} = {}) {
        const box = new St.BoxLayout({style_class: 'tosk-settings-segmented'});
        const buttons = new Map();
        items.forEach(([id, label], i) => {
            const b = new St.Button({
                label,
                style_class: 'tosk-settings-segment',
                can_focus: false,
                x_expand: true,
            });
            if (i === 0)
                b.add_style_class_name('tosk-settings-segment-first');
            if (i === items.length - 1)
                b.add_style_class_name('tosk-settings-segment-last');
            this._scale(b, m => {
                const r = m.radius;
                const left = i === 0 ? r : 0;
                const right = i === items.length - 1 ? r : 0;
                return `min-height: ${Math.round(m.row * 0.72)}px; min-width: ${Math.round(m.row * minRows)}px; ` +
                    `padding: 0 ${m.gap}px; border-radius: ${left}px ${right}px ${right}px ${left}px;`;
            });
            b.connect('clicked', () => {
                // keep the visual state consistent immediately; settings echo confirms it
                for (const [bid, btn] of buttons)
                    btn.checked = bid === id;
                if (!this._syncing)
                    onSelect(id);
            });
            buttons.set(id, b);
            box.add_child(b);
        });
        return {
            actor: box,
            setActive: id => {
                for (const [bid, btn] of buttons)
                    btn.checked = bid === id;
            },
        };
    }

    // ---- layout (1 or 2 columns) ---------------------------------------------------------

    _queueReflow() {
        if (this._reflowId)
            return;
        this._reflowId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reflowId = 0;
            this._reflow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reflow() {
        if (!this._metrics || !this._colA)
            return;
        const width = this.width;
        const colMin = this._metrics.row * 8.5;
        const columns = width > 0 && width >= colMin * 2 + this._metrics.gap * 3 ? 2 : 1;
        if (columns === this._columns)
            return;
        this._columns = columns;

        for (const row of this._order1) {
            const parent = row.get_parent();
            if (parent)
                parent.remove_child(row);
        }
        if (columns === 2) {
            for (const row of this._order2[0])
                this._colA.add_child(row);
            for (const row of this._order2[1])
                this._colB.add_child(row);
            this._colB.show();
        } else {
            for (const row of this._order1)
                this._colA.add_child(row);
            this._colB.hide();
        }
    }

    // ---- settings sync ------------------------------------------------------------------

    _khValue() {
        return snapKeyHeight(KEY_HEIGHT_MIN + this._khSlider.value * (KEY_HEIGHT_MAX - KEY_HEIGHT_MIN));
    }

    _brValue() {
        const v = BRIGHTNESS_MIN + this._brSlider.value * (BRIGHTNESS_MAX - BRIGHTNESS_MIN);
        return Math.round(v * 100) / 100;
    }

    _glowValue() {
        return Math.round(this._glowSlider.value * 100) / 100;
    }

    _syncGlow() {
        const v = this._settings.get_double('key-glow');
        this._withSync(() => {
            this._glowSlider.value = v;
        });
        this._glowLabel.text = formatGlow(v);
    }

    _flashValue() {
        return Math.round(this._flashSlider.value * FLASH_MAX_MS / FLASH_STEP_MS) * FLASH_STEP_MS;
    }

    _syncFlash() {
        const ms = this._settings.get_int('press-flash-ms');
        this._withSync(() => {
            this._flashSlider.value = ms / FLASH_MAX_MS;
        });
        this._flashLabel.text = formatFlash(ms);
    }

    _glowWidthValue() {
        return Math.round(GLOW_W_MIN + this._glowWSlider.value * (GLOW_W_MAX - GLOW_W_MIN));
    }

    _syncGlowWidth() {
        const px = this._settings.get_int('key-glow-width');
        this._withSync(() => {
            this._glowWSlider.value = (px - GLOW_W_MIN) / (GLOW_W_MAX - GLOW_W_MIN);
        });
        this._glowWLabel.text = `${px} px`;
    }

    _dwValue() {
        const v = DOCKED_WIDTH_MIN + this._dwSlider.value * (1 - DOCKED_WIDTH_MIN);
        return Math.round(v * 100) / 100;
    }

    _syncDockedWidth() {
        const v = this._settings.get_double('docked-width');
        this._withSync(() => {
            this._dwSlider.value = (v - DOCKED_WIDTH_MIN) / (1 - DOCKED_WIDTH_MIN);
        });
        this._dwLabel.text = formatPercent(v);
    }

    _opValue() {
        const v = OPACITY_MIN + this._opSlider.value * (OPACITY_MAX - OPACITY_MIN);
        return Math.round(v * 100) / 100;
    }

    _holdValue() {
        return snapHoldMs(HOLD_MIN_MS + this._holdSlider.value * (HOLD_MAX_MS - HOLD_MIN_MS));
    }

    _syncHoldMs() {
        const ms = this._settings.get_int('modifier-hold-ms');
        this._withSync(() => {
            this._holdSlider.value = (ms - HOLD_MIN_MS) / (HOLD_MAX_MS - HOLD_MIN_MS);
        });
        this._holdLabel.text = formatSeconds(snapHoldMs(ms));
    }

    _syncHoldRelease() {
        this._syncSwitch(this._holdSwitch, 'modifier-hold-release');
        this._setRowSensitive(this._rows.holdMs, this._holdSlider,
            this._settings.get_boolean('modifier-hold-release'));
    }

    _stepKeyHeight(delta) {
        const mm = snapKeyHeight(this._khValue() + delta);
        // setting the slider value triggers the debounced write via notify::value
        this._khSlider.value = (mm - KEY_HEIGHT_MIN) / (KEY_HEIGHT_MAX - KEY_HEIGHT_MIN);
    }

    _withSync(fn) {
        const old = this._syncing;
        this._syncing = true;
        try {
            fn();
        } finally {
            this._syncing = old;
        }
    }

    // The key height slider edits the active mode's value (thumb mode has its own).
    _khKey() {
        return this._settings.get_string('mode') === 'thumb' ? 'thumb-key-height-mm' : 'key-height-mm';
    }

    _syncKeyHeight() {
        if (this._khDragging)
            return;
        const mm = this._settings.get_double(this._khKey());
        this._withSync(() => {
            this._khSlider.value = (mm - KEY_HEIGHT_MIN) / (KEY_HEIGHT_MAX - KEY_HEIGHT_MIN);
        });
        this._khLabel.text = formatMm(snapKeyHeight(mm));
    }

    _syncBrightness() {
        const v = this._settings.get_double('label-brightness');
        this._withSync(() => {
            this._brSlider.value = (v - BRIGHTNESS_MIN) / (BRIGHTNESS_MAX - BRIGHTNESS_MIN);
        });
        this._brLabel.text = formatPercent(v);
    }

    _syncOpacity() {
        const v = this._settings.get_double('floating-opacity');
        this._withSync(() => {
            this._opSlider.value = (v - OPACITY_MIN) / (OPACITY_MAX - OPACITY_MIN);
        });
        this._opLabel.text = formatPercent(v);
    }

    _syncSwitch(sw, key) {
        const v = this._settings.get_boolean(key);
        this._withSync(() => {
            sw.checked = v;
        });
        sw._toskKnob.x_align = v ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
    }

    _syncLayout() {
        this._layoutSeg.setActive(this._settings.get_string('layout'));
        const style = this._settings.get_string('layout-style');
        this._styleSeg.setActive(style);
        // F-Reihe only exists in the classic arrangement, Satzanfang groß only in Touch.
        if (this._rows?.fRow)
            this._setRowSensitive(this._rows.fRow, this._fRowSwitch, style !== 'touch');
        if (this._rows?.autoCap)
            this._setRowSensitive(this._rows.autoCap, this._autoCapSwitch, style === 'touch');
    }

    _syncMode() {
        const mode = this._settings.get_string('mode');
        const floating = mode === 'floating';
        this._modeSeg.setActive(mode);
        this._syncKeyHeight();
        this._setRowSensitive(this._rows.shrink, this._shrinkSwitch, !floating);
        this._setRowSensitive(this._rows.opacity, this._opSlider, floating);
        this._setRowSensitive(this._rows.dockedWidth, this._dwSlider, mode === 'docked');
        this._setRowSensitive(this._rows.position, this._posSeg.actor, !floating);
    }

    _setRowSensitive(row, control, sensitive) {
        control.reactive = sensitive;
        row.opacity = sensitive ? 255 : 110;
        if (sensitive)
            row.remove_style_pseudo_class('insensitive');
        else
            row.add_style_pseudo_class('insensitive');
    }

    _syncAll() {
        this._syncKeyHeight();
        this._syncMode();
        this._syncSwitch(this._fRowSwitch, 'show-f-row');
        this._syncLayout();
        this._syncSwitch(this._autoCapSwitch, 'auto-capitalize');
        this._syncSwitch(this._shrinkSwitch, 'shrink-workarea');
        this._syncSwitch(this._autoSwitch, 'auto-show');
        this._syncSwitch(this._submitSwitch, 'hide-after-submit');
        this._syncSwitch(this._dockSwitch, 'move-dock-left');
        this._syncSwitch(this._aspectSwitch, 'keep-key-aspect');
        this._syncOpacity();
        this._syncDockedWidth();
        this._posSeg.setActive(this._settings.get_string('keyboard-position'));
        this._syncBrightness();
        this._syncGlow();
        this._syncGlowWidth();
        this._syncFlash();
        this._superSeg.setActive(this._settings.get_string('super-symbol'));
        this._caseSeg.setActive(this._settings.get_string('letter-case'));
        this._barPosSeg.setActive(this._settings.get_string('suggestion-bar-position'));
        this._syncHoldRelease();
        this._syncHoldMs();
        this._syncSwitch(this._suggestSwitch, 'suggestions');
        this._syncSwitch(this._autocorrectSwitch, 'autocorrect');
        this._syncSwitch(this._hitSwitch, 'dynamic-hitareas');
        this._langSeg.setActive(this._settings.get_string('prediction-language'));
    }

    _flushWrites() {
        this._khWriter.flush();
        this._opWriter.flush();
        this._dwWriter.flush();
        this._brWriter.flush();
        this._glowWriter.flush();
        this._glowWWriter.flush();
        this._flashWriter.flush();
        this._holdWriter.flush();
    }

    _onDestroy() {
        this._flushWrites();
        this._khWriter.cancel();
        this._opWriter.cancel();
        this._dwWriter.cancel();
        this._brWriter.cancel();
        this._glowWriter.cancel();
        this._glowWWriter.cancel();
        this._flashWriter.cancel();
        this._holdWriter.cancel();
        if (this._clearConfirmId) {
            GLib.source_remove(this._clearConfirmId);
            this._clearConfirmId = 0;
        }
        this._clearButton = null;
        if (this._reflowId) {
            GLib.source_remove(this._reflowId);
            this._reflowId = 0;
        }
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._scaled = [];
    }
});
