// SPDX-License-Identifier: GPL-2.0-or-later
// Physical (external) keyboard detection for tablet-osk.
//
// Decision rule (see isExternalKeyboard()):
//   A device counts as an "external" physical keyboard when it is keyboard-capable
//   (device type KEYBOARD_DEVICE or KEYBOARD capability), physical (not the logical
//   core device), not on the built-in name denylist, not a mouse interface, not on a
//   built-in bus (i8042 / ACPI host), and not overridden by DEVICE_OVERRIDES.
//   This deliberately does NOT require USB: the Lenovo Miix 520 keyboard cover is
//   USB-connected internally and should count as a physical keyboard (attached cover
//   = no auto-show).
//
//   Known limitation: a Logitech USB receiver exposes a keyboard-capable interface
//   ("Logitech USB Receiver") even when only a mouse is paired. That cannot be told
//   apart from a receiver with a paired keyboard, so by default it counts as an
//   external keyboard. Add an entry to DEVICE_OVERRIDES to change that for a specific
//   receiver (vendor/product id), or use the ignore-physical-keyboard setting.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const LOG_PREFIX = '[tablet-osk]';

// Names (case-insensitive substrings / regexes) of keyboard-capable devices that are
// built into the machine or are not real keyboards.
export const NAME_DENYLIST = [
    /AT Translated/i,          // built-in PS/2 keyboard (i8042)
    /i8042/i,
    /Power Button/i,
    /Sleep Button/i,
    /Lid Switch/i,
    /Tablet Mode Switch/i,
    /Video Bus/i,
    /Extra Buttons/i,          // ThinkPad / Ideapad extra buttons
    /Intel HID/i,              // Intel HID events / 5 button array
    /Intel Virtual Buttons/i,
    /HDA /i,
    /HDMI/i,
    /Headphone/i,
    /\bMic\b/i,
    /Consumer Control/i,
    /System Control/i,
    /Wireless Radio Control/i,
    /WMI hotkeys/i,
    /PC Speaker/i,
    /gpio[-_ ]keys/i,
    /soc_button_array/i,
    /Mouse/i,                  // mouse interfaces of receivers/combos
    /Touchpad/i,
    /TrackPoint/i,
    /Pen\b/i,
    /Stylus/i,
    /Touchscreen/i,
    /virtual/i,
    /ydotool/i,
    /gnome-shell/i,
    /tablet-osk/i,             // our own virtual device (if it ever shows up)
];

// Explicit per-device overrides, checked before every other rule (GSettings-free, edit
// here to tune). Each entry: {name?: RegExp, vendorId?: '046d', productId?: 'c548',
// external: boolean}. All given fields must match.
export const DEVICE_OVERRIDES = [
    // Example: treat a mouse-only Logitech Bolt receiver as non-keyboard:
    // {vendorId: '046d', productId: 'c548', name: /^Logitech USB Receiver$/, external: false},
];

// Linux input bus types (include/uapi/linux/input.h), as 4-digit hex strings.
const BUS_I8042 = '0011';
const BUS_HOST = '0019';
const INTERNAL_BUSES = [BUS_I8042, BUS_HOST];

// Numeric enum values from Clutter-14 (kept here so the helper stays pure).
const KEYBOARD_DEVICE = 1;   // Clutter.InputDeviceType.KEYBOARD_DEVICE
const CAP_KEYBOARD = 2;      // Clutter.InputCapabilities.KEYBOARD
const MODE_LOGICAL = 0;      // Clutter.InputMode.LOGICAL

function _norm(id) {
    if (id === null || id === undefined)
        return '';
    return String(id).toLowerCase().padStart(4, '0');
}

function _overrideFor({name, vendorId, productId}) {
    for (const o of DEVICE_OVERRIDES) {
        if (o.name && !o.name.test(name ?? ''))
            continue;
        if (o.vendorId && _norm(o.vendorId) !== _norm(vendorId))
            continue;
        if (o.productId && _norm(o.productId) !== _norm(productId))
            continue;
        return o;
    }
    return null;
}

/**
 * Pure classification helper (no gi usage).
 *
 * @param {object} dev
 * @param {string} dev.name - device name
 * @param {number} [dev.type] - Clutter.InputDeviceType value (1 = keyboard)
 * @param {number} [dev.capabilities] - Clutter.InputCapabilities bitmask
 * @param {number} [dev.mode] - Clutter.InputMode (0 = logical → never external)
 * @param {string} [dev.vendorId] - hex vendor id, e.g. '046d'
 * @param {string} [dev.productId] - hex product id
 * @param {string} [dev.node] - device node, e.g. '/dev/input/event15'
 * @param {string} [dev.bus] - hex bus type from sysfs, e.g. '0003' (USB)
 * @returns {boolean}
 */
export function isExternalKeyboard({name, type, capabilities, mode, vendorId, productId, node, bus} = {}) {
    void node;
    const override = _overrideFor({name, vendorId, productId});
    if (override)
        return !!override.external;

    if (mode === MODE_LOGICAL)
        return false;

    const keyboardCapable = type === KEYBOARD_DEVICE ||
        (typeof capabilities === 'number' && (capabilities & CAP_KEYBOARD) !== 0);
    if (!keyboardCapable)
        return false;

    const n = name ?? '';
    if (NAME_DENYLIST.some(re => re.test(n)))
        return false;

    if (bus && INTERNAL_BUSES.includes(_norm(bus)))
        return false;

    return true;
}

function _readBus(node) {
    // node: /dev/input/eventN → /sys/class/input/eventN/device/id/bustype
    if (!node)
        return null;
    const base = GLib.path_get_basename(node);
    if (!/^event\d+$/.test(base))
        return null;
    try {
        const [ok, bytes] = GLib.file_get_contents(`/sys/class/input/${base}/device/id/bustype`);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

function _describe(device) {
    const safe = f => {
        try {
            return f();
        } catch {
            return null;
        }
    };
    const node = safe(() => device.get_device_node());
    return {
        name: safe(() => device.get_device_name()) ?? '',
        type: safe(() => device.get_device_type()),
        capabilities: safe(() => device.get_capabilities()),
        mode: safe(() => device.get_device_mode()),
        vendorId: safe(() => device.get_vendor_id()),
        productId: safe(() => device.get_product_id()),
        node,
        bus: _readBus(node),
    };
}

function _fmt(d, external) {
    return `${external ? 'EXTERNAL' : 'ignored '} name="${d.name}" type=${d.type} caps=${d.capabilities} ` +
        `mode=${d.mode} id=${d.vendorId}:${d.productId} bus=${d.bus} node=${d.node}`;
}

export class PhysicalKeyboardMonitor {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._external = new Set();
        this._listeners = new Set();
        this._seat = Clutter.get_default_backend().get_default_seat();

        console.log(`${LOG_PREFIX} input devices at startup:`);
        for (const device of this._seat.list_devices())
            this._classify(device, 'startup');
        console.log(`${LOG_PREFIX} external keyboard present: ${this.present}`);

        this._seat.connectObject(
            'device-added', (_seat, device) => this._onAdded(device),
            'device-removed', (_seat, device) => this._onRemoved(device),
            this);
    }

    // Extra (non-contract) API used by VisibilityController: additional change listeners.
    addListener(fn) {
        this._listeners.add(fn);
        return fn;
    }

    removeListener(fn) {
        this._listeners.delete(fn);
    }

    get present() {
        return this._external.size > 0;
    }

    _classify(device, reason) {
        const d = _describe(device);
        const external = isExternalKeyboard(d);
        console.log(`${LOG_PREFIX} [${reason}] ${_fmt(d, external)}`);
        if (external)
            this._external.add(device);
        return external;
    }

    _onAdded(device) {
        const before = this.present;
        this._classify(device, 'added');
        this._notifyIfChanged(before);
    }

    _onRemoved(device) {
        const before = this.present;
        let name = '';
        try {
            name = device.get_device_name();
        } catch {}
        const was = this._external.delete(device);
        console.log(`${LOG_PREFIX} [removed] ${was ? 'EXTERNAL' : 'ignored '} name="${name}"`);
        this._notifyIfChanged(before);
    }

    _notifyIfChanged(before) {
        const now = this.present;
        if (now === before)
            return;
        console.log(`${LOG_PREFIX} external keyboard present: ${now}`);
        for (const fn of [this._onChanged, ...this._listeners]) {
            try {
                fn?.(now);
            } catch (e) {
                console.error(`${LOG_PREFIX} onChanged failed: ${e}`);
            }
        }
    }

    destroy() {
        this._seat?.disconnectObject(this);
        this._seat = null;
        this._external.clear();
        this._listeners.clear();
        this._onChanged = null;
    }
}
