// workarea.js — physical monitor metrics + work-area (strut) management.
//
// Findings from GNOME Shell 46 ui/layout.js that shaped this module:
//
//  * LayoutManager._updateRegions() computes a strut for every tracked actor
//    with affectsStruts:true from actor.get_transformed_position() /
//    get_transformed_size(). It does NOT look at `visible` for struts (only
//    the input region checks get_paint_visibility()), so a hidden actor keeps
//    reserving space (the addChrome() doc comment says the same).
//  * The transformed position includes translation_y, so a container that
//    slides via translation_y would yield a strut that depends on the current
//    animation frame. Regions are only recomputed on notify::allocation /
//    notify::visible of tracked actors (and on unrelated triggers such as
//    restacking), and a translation change is not an allocation change, so
//    the strut would be whatever value happened to be sampled: wrong and
//    flickery.
//  * Tracking parameters cannot be changed after the fact, but
//    trackChrome()/untrackChrome() can add/remove an actor that is already in
//    uiGroup without reparenting it.
//
// So WorkArea adds the keyboard container as ordinary chrome (input region,
// no struts) and uses a separate invisible "strut proxy" actor in uiGroup.
// A Clutter.BindConstraint ties it to the container's *allocation*, so
// translation_y never changes it. The proxy is tracked with
// affectsStruts:true only while (shown && shrink-workarea && mode != floating), so the strut is
// exactly the full keyboard height while shown and gone while hidden.
//
// (The built-in OSK never uses struts: keyboardBox is addTopChrome'd with
// default params and it moves the focused window out of the way instead.)

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DC_NAME = 'org.gnome.Mutter.DisplayConfig';
const DC_PATH = '/org/gnome/Mutter/DisplayConfig';
const DC_IFACE = 'org.gnome.Mutter.DisplayConfig';
const DBUS_TIMEOUT_MS = 5000;

// Plausible logical px/mm. Anything outside this range means the EDID size is bogus.
const MIN_PX_PER_MM = 1.5;
const MAX_PX_PER_MM = 40;

// EDIDs that store the aspect ratio instead of the size (same list as mutter's
// meta_monitor_has_aspect_as_size()).
function isAspectAsSize(wMm, hMm) {
    const pairs = [[16, 9], [16, 10], [160, 90], [160, 100], [1600, 900], [1600, 1000]];
    return pairs.some(([a, b]) => (wMm === a && hMm === b) || (wMm === b && hMm === a));
}

export class MonitorMetrics {
    /**
     * @param {Function} onChanged called (no args) after physical sizes were
     *   (re)read or fallback-dpi changed; callers re-query keyHeightPx().
     * @param {Gio.Settings} [settings] optional; looked up from the extension otherwise.
     */
    constructor(onChanged, settings = null) {
        this._onChanged = onChanged ?? (() => {});
        this._settings = settings ??
            Extension.lookupByURL(import.meta.url)?.getSettings() ?? null;

        // [{x, y, mmW, mmH}] per logical monitor; mmW/mmH are aligned with the
        // monitor's on-screen horizontal/vertical axes.
        this._logicalMonitors = [];
        this._cancellable = null;
        this._generation = 0;
        this._destroyed = false;

        Main.layoutManager.connectObject('monitors-changed',
            () => this._refresh(), this);
        this._settings?.connectObject('changed::fallback-dpi',
            () => this._notify(), this);

        this._refresh();
    }

    _fallbackPxPerMm() {
        // fallback-dpi is interpreted as *logical* (stage) px per inch, i.e. the
        // unit our actor sizes are in. 96 is the classic logical density, so on a
        // 2x HiDPI screen this corresponds to 192 physical dpi, which is about right.
        const dpi = this._settings?.get_double('fallback-dpi') ?? 96;
        return dpi / 25.4;
    }

    /**
     * Logical (stage) px per mm for Main.layoutManager.monitors[monitorIndex].
     * Stage coordinates already include the monitor scale (logical layout mode),
     * so logical width / physical width in mm == physical px / mm / scale.
     */
    pxPerMm(monitorIndex) {
        const mon = Main.layoutManager.monitors[monitorIndex];
        if (!mon)
            return this._fallbackPxPerMm();

        const lm = this._logicalMonitors.find(l => l.x === mon.x && l.y === mon.y) ??
            (this._logicalMonitors.length === 1 && Main.layoutManager.monitors.length === 1
                ? this._logicalMonitors[0] : null);
        if (!lm)
            return this._fallbackPxPerMm();

        // Use the longer physical axis: EDID sizes are rounded, so the larger
        // number has the smaller relative error.
        const ppm = lm.mmW >= lm.mmH ? mon.width / lm.mmW : mon.height / lm.mmH;
        if (!Number.isFinite(ppm) || ppm < MIN_PX_PER_MM || ppm > MAX_PX_PER_MM)
            return this._fallbackPxPerMm();
        return ppm;
    }

    keyHeightPx(monitorIndex, mm) {
        return Math.round(mm * this.pxPerMm(monitorIndex));
    }

    _notify() {
        if (this._destroyed)
            return;
        try {
            this._onChanged();
        } catch (e) {
            logError(e, 'tablet-osk: MonitorMetrics onChanged failed');
        }
    }

    _call(method, cancellable) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(DC_NAME, DC_PATH, DC_IFACE, method,
                null, null, Gio.DBusCallFlags.NONE, DBUS_TIMEOUT_MS, cancellable,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _refresh() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const generation = ++this._generation;

        let resources, state;
        try {
            [resources, state] = await Promise.all([
                this._call('GetResources', cancellable),
                this._call('GetCurrentState', cancellable),
            ]);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._destroyed)
                return;
            console.warn(`tablet-osk: DisplayConfig query failed, using fallback-dpi: ${e.message}`);
            if (generation === this._generation) {
                this._logicalMonitors = [];
                this._notify();
            }
            return;
        }
        if (this._destroyed || generation !== this._generation)
            return;

        try {
            this._logicalMonitors = this._parse(resources, state);
        } catch (e) {
            logError(e, 'tablet-osk: failed to parse DisplayConfig data');
            this._logicalMonitors = [];
        }
        this._notify();
    }

    _parse(resources, state) {
        // GetResources: (u serial, a(uxiiiiiuaua{sv}) crtcs,
        //   a(uxiausauaua{sv}) outputs, a(uxuudu) modes, i max_w, i max_h)
        // output: (id, winsys_id, current_crtc, possible_crtcs, name, modes, clones, props)
        const [, , outputs] = resources.deepUnpack();
        const mmByConnector = new Map();
        for (const out of outputs) {
            const name = out[4];
            const props = out[7];
            const w = props['width-mm']?.unpack() ?? 0;
            const h = props['height-mm']?.unpack() ?? 0;
            if (w > 0 && h > 0 && !isAspectAsSize(w, h))
                mmByConnector.set(name, [w, h]);
        }

        // GetCurrentState: (u serial, a((ssss)a(siiddada{sv})a{sv}) monitors,
        //   a(iiduba(ssss)a{sv}) logical_monitors, a{sv} props)
        const [, , logicalMonitors] = state.deepUnpack();
        const result = [];
        for (const lmData of logicalMonitors) {
            const [x, y, , transform, , specs] = lmData;
            const known = specs.map(s => mmByConnector.get(s[0])).find(v => v);
            if (!known)
                continue;
            let [mmW, mmH] = known;

            // Align physical axes with the on-screen axes. Rather than trusting
            // only the transform (panel-orientation quirks on tablets mean the
            // native panel may be portrait while transform is 0), match by aspect
            // against the current logical geometry; fall back to the transform for
            // (near-)square monitors or if the monitor is not in layoutManager yet.
            const mon = Main.layoutManager.monitors.find(m => m.x === x && m.y === y);
            let swap = transform % 2 === 1; // 1/3/5/7 = 90/270 (flipped) rotations
            if (mon && mon.width !== mon.height && mmW !== mmH)
                swap = (mon.width > mon.height) !== (mmW > mmH);
            if (swap)
                [mmW, mmH] = [mmH, mmW];

            result.push({x, y, mmW, mmH});
        }
        return result;
    }

    destroy() {
        this._destroyed = true;
        this._cancellable?.cancel();
        this._cancellable = null;
        Main.layoutManager.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._onChanged = null;
    }
}

export class WorkArea {
    /**
     * @param {Clutter.Actor} actor keyboard container (not yet parented)
     * @param {Gio.Settings} settings extension settings (shrink-workarea)
     */
    constructor(actor, settings) {
        this._actor = actor;
        this._settings = settings;
        this._shown = false;
        this._strutTracked = false;

        // Above windows (below popup menus / top_window_group), receives input,
        // never reserves space itself.
        Main.layoutManager.addChrome(actor, {
            affectsStruts: false,
            affectsInputRegion: true,
            trackFullscreen: false,
        });

        // Invisible proxy that mirrors the container's allocation (ignores
        // translation), used for the strut only. Must stay visible=true so it
        // keeps being allocated; it has no content, so nothing is painted.
        this._strut = new Clutter.Actor({
            name: 'tabletOskStrut',
            reactive: false,
            opacity: 0,
        });
        this._strut.add_constraint(new Clutter.BindConstraint({
            source: actor,
            coordinate: Clutter.BindCoordinate.ALL, // position + size
        }));
        // Sibling directly above the container so it is allocated after it.
        Main.layoutManager.uiGroup.insert_child_above(this._strut, actor);

        this._settings.connectObject(
            'changed::shrink-workarea', () => this._sync(),
            'changed::mode', () => this._sync(), this);
        this._sync();
    }

    /**
     * Call with true *before* starting the slide-in animation and with false
     * *after* the slide-out finished; the strut covers the full keyboard height
     * from setShown(true) until setShown(false) independent of translation_y.
     */
    setShown(shown) {
        this._shown = !!shown;
        this._sync();
    }

    _sync() {
        // Floating mode never reserves space (read here so a live mode switch
        // while shown drops/restores the strut without coordinator help).
        const want = this._shown &&
            this._settings.get_boolean('shrink-workarea') &&
            this._settings.get_string('mode') !== 'floating';
        if (want === this._strutTracked || !this._strut)
            return;

        if (want) {
            Main.layoutManager.trackChrome(this._strut, {
                affectsStruts: true,
                affectsInputRegion: false,
                trackFullscreen: false,
            });
        } else {
            Main.layoutManager.untrackChrome(this._strut);
        }
        this._strutTracked = want;
    }

    destroy() {
        this._settings?.disconnectObject(this);

        if (this._strut) {
            if (this._strutTracked)
                Main.layoutManager.untrackChrome(this._strut);
            this._strutTracked = false;
            this._strut.destroy();
            this._strut = null;
        }

        if (this._actor && this._actor.get_parent() === Main.layoutManager.uiGroup)
            Main.layoutManager.removeChrome(this._actor);
        else if (this._actor)
            Main.layoutManager.untrackChrome(this._actor); // no-op if untracked

        this._actor = null;
        this._settings = null;
    }
}
