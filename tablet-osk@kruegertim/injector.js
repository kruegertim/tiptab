// Key injection through a Clutter virtual keyboard device.
// Techniques follow GNOME Shell's own KeyboardController (ui/keyboard.js).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class KeyInjector {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._pressed = new Set();
    }

    _time() {
        // Outside of event handlers (e.g. key-repeat timeouts) there is no
        // current event; fall back to the monotonic clock (same time base).
        const t = Clutter.get_current_event_time();
        return t ? t * 1000 : GLib.get_monotonic_time();
    }

    press(keyval) {
        if (!this._device || !keyval)
            return;
        this._device.notify_keyval(this._time(), keyval, Clutter.KeyState.PRESSED);
        this._pressed.add(keyval);
    }

    release(keyval) {
        if (!this._device || !keyval)
            return;
        this._device.notify_keyval(this._time(), keyval, Clutter.KeyState.RELEASED);
        this._pressed.delete(keyval);
    }

    tap(keyval, modifierKeyvals = []) {
        for (const m of modifierKeyvals)
            this.press(m);
        this.press(keyval);
        this.release(keyval);
        for (const m of [...modifierKeyvals].reverse())
            this.release(m);
    }

    _keyvalsFromString(str) {
        const keyvals = [];
        for (const ch of str) {
            const cp = ch.codePointAt(0);
            const keyval = Clutter.unicode_to_keysym(cp);
            // Unknown characters map to 0x01000000 | cp; the compositor can
            // still try, but there is no keycode for them in most keymaps.
            keyvals.push(keyval);
        }
        return keyvals;
    }

    typeChar(str, modifierKeyvals = []) {
        if (!str)
            return;
        const hasMods = modifierKeyvals && modifierKeyvals.length > 0;

        // Layout-independent path: commit the text through the input method.
        if (!hasMods && Main.inputMethod.currentFocus) {
            Main.inputMethod.commit(str);
            return;
        }

        // Fallback (X11 clients without IM focus, or shortcuts with modifiers):
        // mutter maps keysym -> keycode (+ level modifiers) of the current keymap.
        for (const m of modifierKeyvals)
            this.press(m);
        for (const keyval of this._keyvalsFromString(str)) {
            this.press(keyval);
            this.release(keyval);
        }
        for (const m of [...modifierKeyvals].reverse())
            this.release(m);
    }

    releaseAll() {
        for (const keyval of [...this._pressed])
            this.release(keyval);
        this._pressed.clear();
    }

    destroy() {
        if (!this._device)
            return;
        this.releaseAll();
        // Release anything still held by the device right away (like the shell does).
        this._device.run_dispose();
        this._device = null;
    }
}
