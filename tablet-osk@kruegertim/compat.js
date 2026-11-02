// SPDX-License-Identifier: GPL-2.0-or-later
// Small helpers for differences between GNOME Shell 46 and 50.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let _inputRegionParam = null;

// GNOME 49+ dropped the X11 input region and LayoutManager rejects the
// `affectsInputRegion` chrome parameter ("Unrecognized parameter"). Probe once by
// tracking a throwaway actor (addChrome itself would already have reparented the
// real actor before throwing).
function _supportsInputRegionParam() {
    if (_inputRegionParam !== null)
        return _inputRegionParam;
    const lm = Main.layoutManager;
    const probe = new Clutter.Actor();
    try {
        lm._trackActor(probe, {affectsInputRegion: true});
        lm._untrackActor(probe);
        _inputRegionParam = true;
    } catch {
        _inputRegionParam = false;
    } finally {
        probe.destroy();
    }
    return _inputRegionParam;
}

/**
 * Returns chrome params for addChrome/addTopChrome/trackChrome, minus the keys the
 * running shell does not know.
 *
 * @param {object} params
 * @returns {object}
 */
export function chromeParams(params) {
    if ('affectsInputRegion' in params && !_supportsInputRegionParam()) {
        const {affectsInputRegion: _unused, ...rest} = params;
        return rest;
    }
    return params;
}

// Meta.is_wayland_compositor() was removed in GNOME 50 (Wayland-only, the X11 session
// is gone), so its absence means Wayland.
export function isWaylandCompositor() {
    return typeof Meta.is_wayland_compositor === 'function'
        ? Meta.is_wayland_compositor() : true;
}
