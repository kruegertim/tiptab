// OskKeyboard: the key grid widget (handle bar + rows of keys [+ footer with
// resize grip in floating mode]).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {getLayout, TOTAL_UNITS, FALLBACK_KEYVALS} from './layouts.js';
import {KeyInjector} from './injector.js';

const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 50;
const SHIFT_DOUBLE_TAP_MS = 400;
const FLOAT_BORDER_PX = 1;

const LATCH_MODIFIERS = ['altgr', 'fn', 'ctrl', 'alt', 'super'];

function resolveKeyval(name) {
    if (!name)
        return 0;
    if (typeof name === 'number')
        return name;
    return Clutter[`KEY_${name}`] ?? FALLBACK_KEYVALS[name] ?? 0;
}

function isPress(type) {
    return type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN;
}

/**
 * Attach press/release/cancel handling (pointer + Wayland touch) to a reactive
 * actor, modelled on the shell's Key._makeKey(). Handlers return EVENT_STOP so
 * nothing propagates to parents (e.g. the handle's swipe logic).
 */
function attachPressHandlers(actor, {onPress, onRelease, onCancel}) {
    let pointerDown = false;
    let touchSlot = null;

    actor.connect('button-press-event', (a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        pointerDown = true;
        onPress();
        return Clutter.EVENT_STOP;
    });
    actor.connect('button-release-event', (a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !pointerDown)
            return Clutter.EVENT_STOP;
        pointerDown = false;
        onRelease();
        return Clutter.EVENT_STOP;
    });
    actor.connect('touch-event', (a, event) => {
        // On X11 touch is emulated as pointer events, which we handle above.
        if (!Meta.is_wayland_compositor())
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        const slot = event.get_event_sequence().get_slot();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            if (touchSlot === null) {
                touchSlot = slot;
                onPress();
            }
        } else if (type === Clutter.EventType.TOUCH_END) {
            if (touchSlot === slot) {
                touchSlot = null;
                onRelease();
            }
        } else if (type === Clutter.EventType.TOUCH_CANCEL) {
            if (touchSlot === slot) {
                touchSlot = null;
                onCancel?.();
            }
        }
        return Clutter.EVENT_STOP;
    });
    return {
        reset() {
            pointerDown = false;
            touchSlot = null;
        },
    };
}

// ---------------------------------------------------------------- Key

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
        this.extendDown = def.enterPart === 'top';

        const corner = (x, y, cls, text) => {
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
        };
        const S = Clutter.ActorAlign.START, E = Clutter.ActorAlign.END, C = Clutter.ActorAlign.CENTER;

        this._main = null;
        this._mainIcon = null;
        if (def.icon) {
            this._mainIcon = new St.Icon({
                icon_name: def.icon,
                style_class: 'tosk-icon-main',
                x_expand: true, y_expand: true, x_align: C, y_align: C,
            });
            this.add_child(this._mainIcon);
        } else if (def.label) {
            const topLeft = def.labelPos === 'tl';
            this._main = corner(topLeft ? S : C, topLeft ? S : C,
                topLeft ? 'tosk-label-main tosk-label-small' : 'tosk-label-main', def.label);
            this._mainSmall = topLeft;
        }
        this._shift = def.shiftLabel ? corner(S, S, 'tosk-label-shift', def.shiftLabel) : null;
        this._altgr = def.altgrLabel ? corner(E, E, 'tosk-label-altgr', def.altgrLabel) : null;

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

        this._press = attachPressHandlers(this, {
            onPress: () => this._keyboard._onKeyPress(this),
            onRelease: () => this._keyboard._onKeyRelease(this),
            onCancel: () => this._keyboard._onKeyCancel(this),
        });
    }

    setHeight(h) {
        const big = Math.round(h * 0.38);
        const small = Math.max(7, Math.round(h * 0.22));
        const padV = Math.round(h * 0.07), padH = Math.round(h * 0.1);
        this.style = `padding: ${padV}px ${padH}px;`;

        if (this._main) {
            let size = big;
            if (this._mainSmall)
                size = Math.round(h * 0.24);
            else if ([...this.def.label].length > 1)
                size = Math.round(h * 0.3);
            this._main.style = `font-size: ${size}px;`;
        }
        if (this._mainIcon)
            this._mainIcon.icon_size = Math.round(h * 0.4);
        if (this._shift)
            this._shift.style = `font-size: ${small}px;`;
        if (this._altgr)
            this._altgr.style = `font-size: ${small}px;`;
        if (this._fnIcon)
            this._fnIcon.icon_size = Math.round(h * (this.def.fnCentre ? 0.34 : 0.22));
        if (this._fnText)
            this._fnText.style = `font-size: ${this.def.fnCentre ? Math.round(h * 0.26) : small}px;`;
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
        this._press.reset();
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
        const unit = (width + gap) / TOTAL_UNITS;
        let cum = 0;
        for (const child of this.get_children()) {
            const x1 = content.x1 + Math.round(cum * unit);
            cum += child.units;
            const x2 = Math.max(x1, content.x1 + Math.round(cum * unit) - gap);
            const y2 = content.y2 + (child.extendDown ? gap : 0);
            child.allocate(Clutter.ActorBox.new(x1, content.y1, x2, y2));
        }
    }
});

// ---------------------------------------------------------------- Keyboard

export const OskKeyboard = GObject.registerClass({
    Signals: {
        'hide-request': {},
        'settings-request': {},
        'layout-changed': {}, // emitted after a rebuild (row count may change)
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
        this._barHeight = 24;
        this._floating = false;

        this._shift = 0; // 0 off, 1 one-shot, 2 locked
        this._lastShiftTap = 0;
        this._caps = false;
        this._latched = new Set();

        this._keys = [];
        this._repeatKey = null;
        this._repeatId = 0;

        this._buildHandle();
        this._rowsBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tosk-rows'});
        this.add_child(this._rowsBox);
        this._buildFooter();

        this._settings.connectObject(
            'changed::layout', () => this._rebuild(),
            'changed::show-f-row', () => this._rebuild(),
            this);

        this.connect('destroy', () => this._onDestroy());

        this._rebuild(false);
        this.setKeyHeight(this._keyHeight);
    }

    // ------------------------------------------------------------ public API

    get handle() {
        return this._handle;
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

    setKeyHeight(px) {
        const h = Math.max(12, Math.round(px));
        this._keyHeight = h;
        this._gap = Math.min(8, Math.max(3, Math.round(h * 0.08)));
        this._pad = this._gap;
        this._barHeight = Math.max(18, Math.round(h * 0.5));
        const btnW = Math.max(36, Math.round(h * 0.9));

        this._applyContainerStyle();
        this._rowsBox.style = `spacing: ${this._gap}px;`;

        this._handle.height = this._barHeight;
        this._grip.set_size(Math.max(32, Math.round(h * 0.9)), 5);
        this._gear.set_size(btnW, this._barHeight);
        this._gearIcon.icon_size = Math.round(Math.min(this._barHeight * 0.7, h * 0.4));

        this._footer.height = this._barHeight;
        this._resizeGrip.set_size(btnW, this._barHeight);
        this._resizeGripLabel.style = `font-size: ${Math.round(this._barHeight * 0.75)}px;`;

        for (const k of this._keys)
            k.setHeight(h);
        this.queue_relayout();
    }

    get preferredHeight() {
        const n = this._rows.length;
        let height = this._barHeight + n * this._keyHeight + Math.max(0, n - 1) * this._gap + this._pad;
        if (this._floating)
            height += this._barHeight + 2 * FLOAT_BORDER_PX;
        return height;
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
        this._footer.visible = floating;
        this._applyContainerStyle();
        this.queue_relayout();
    }

    resetModifiers() {
        this._stopRepeat();
        for (const k of this._keys)
            k.resetPress();
        this._injector.releaseAll();
        this._shift = 0;
        this._latched.clear();
        this._updateModifierState();
    }

    // ------------------------------------------------------------ building

    _applyContainerStyle() {
        const p = this._pad;
        let style = `padding: 0 ${p}px ${p}px ${p}px; spacing: 0;`;
        if (this._floating)
            style += ` border-width: ${FLOAT_BORDER_PX}px;`;
        this.style = style;
    }

    _buildHandle() {
        this._handle = new St.Widget({
            style_class: 'tosk-handle',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: false,
            x_expand: true,
        });
        this._grip = new St.Widget({
            style_class: 'tosk-handle-grip',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._handle.add_child(this._grip);

        this._gear = new St.Widget({
            style_class: 'tosk-handle-button',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: false,
            track_hover: false,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._gearIcon = new St.Icon({
            icon_name: 'emblem-system-symbolic',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._gear.add_child(this._gearIcon);
        attachPressHandlers(this._gear, {
            onPress: () => this._gear.add_style_pseudo_class('active'),
            onRelease: () => {
                this._gear.remove_style_pseudo_class('active');
                this.emit('settings-request');
            },
            onCancel: () => this._gear.remove_style_pseudo_class('active'),
        });
        this._handle.add_child(this._gear);
        this.add_child(this._handle);
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
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._resizeGripLabel = new St.Label({
            text: '⇲',
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._resizeGrip.add_child(this._resizeGripLabel);
        this._footer.add_child(this._resizeGrip);
        this.add_child(this._footer);
    }

    _rebuild(emit = true) {
        this._stopRepeat();
        this._injector.releaseAll();
        this._rowsBox.destroy_all_children();
        this._keys = [];
        this._modifierKeys = {};
        this._rows = getLayout({
            layout: this._settings.get_string('layout'),
            fRow: this._settings.get_boolean('show-f-row'),
        });

        const enterParts = [];
        for (const rowDef of this._rows) {
            const row = new KeyRow(this);
            for (const def of rowDef) {
                const key = new OskKey(def, this);
                row.add_child(key);
                this._keys.push(key);
                if (def.type === 'modifier')
                    this._modifierKeys[def.modifier] = key;
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

    // ------------------------------------------------------------ events

    _onKeyPress(key) {
        const def = key.def;
        key.setActive(true);
        switch (def.type) {
        case 'modifier':
            this._toggleModifier(def.modifier);
            break;
        case 'hide':
            break;
        default:
            this._stopRepeat();
            key._activated = true;
            this._activate(def);
            if (def.repeat)
                this._startRepeat(key);
        }
    }

    _onKeyRelease(key) {
        key.setActive(false);
        if (this._repeatKey === key)
            this._stopRepeat();
        if (key.def.type === 'hide') {
            this.emit('hide-request');
            return;
        }
        if (key._activated) {
            key._activated = false;
            this._consumeOneShots();
        }
    }

    _onKeyCancel(key) {
        key.setActive(false);
        if (this._repeatKey === key)
            this._stopRepeat();
        if (key._activated) {
            key._activated = false;
            this._consumeOneShots();
        }
    }

    _startRepeat(key) {
        this._repeatKey = key;
        this._repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_DELAY_MS, () => {
            this._repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_INTERVAL_MS, () => {
                if (!key.mapped) {
                    this._repeatId = 0;
                    this._repeatKey = null;
                    return GLib.SOURCE_REMOVE;
                }
                this._activate(key.def);
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
        this._repeatKey = null;
    }

    // ------------------------------------------------------------ modifiers

    _toggleModifier(mod) {
        if (mod === 'shift') {
            const now = GLib.get_monotonic_time() / 1000;
            if (this._shift === 2)
                this._shift = 0;
            else if (this._shift === 1 && now - this._lastShiftTap < SHIFT_DOUBLE_TAP_MS)
                this._shift = 2;
            else if (this._shift === 1)
                this._shift = 0;
            else
                this._shift = 1;
            this._lastShiftTap = now;
        } else if (mod === 'caps') {
            // OSK-internal caps lock (see report: no real Caps_Lock, because the
            // keysym fallback path would otherwise invert the case twice).
            this._caps = !this._caps;
        } else if (this._latched.has(mod)) {
            this._latched.delete(mod);
        } else {
            this._latched.add(mod);
        }
        this._updateModifierState();
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
        mk.shift?.setLatched(this._shift === 1, this._shift === 2);
        mk.caps?.setLatched(false, this._caps);
        for (const m of LATCH_MODIFIERS)
            mk[m]?.setLatched(this._latched.has(m));
        if (this._latched.has('fn'))
            this.add_style_class_name('tosk-fn-on');
        else
            this.remove_style_class_name('tosk-fn-on');
    }

    _shortcutModifiers() {
        const mods = [];
        if (this._latched.has('ctrl'))
            mods.push(Clutter.KEY_Control_L);
        if (this._latched.has('alt'))
            mods.push(Clutter.KEY_Alt_L);
        if (this._latched.has('super'))
            mods.push(Clutter.KEY_Super_L);
        return mods;
    }

    // ------------------------------------------------------------ output

    _activate(def) {
        if (!this._injector)
            return;
        const mods = this._shortcutModifiers();
        const shift = this._shift > 0;
        const withShift = shift ? [Clutter.KEY_Shift_L, ...mods] : mods;

        if (this._latched.has('fn') && def.fnKeysym) {
            this._injector.tap(resolveKeyval(def.fnKeysym), withShift);
            return;
        }

        if (def.type === 'char') {
            const altgr = this._latched.has('altgr') && def.altgrChar;
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
                return;
            }
            this._injector.typeChar(this._charFor(def), []);
            return;
        }

        // special / enter
        const keyval = resolveKeyval(def.keysym);
        if (keyval)
            this._injector.tap(keyval, withShift);
    }

    _charFor(def) {
        if (this._latched.has('altgr') && def.altgrChar)
            return def.altgrChar;
        const shift = this._shift > 0;
        if (def.letter)
            return shift !== this._caps ? def.shiftChar : def.char;
        return shift ? def.shiftChar ?? def.char : def.char;
    }

    // ------------------------------------------------------------ teardown

    _onDestroy() {
        this._stopRepeat();
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._injector?.destroy();
        this._injector = null;
        this._keys = [];
    }
});
