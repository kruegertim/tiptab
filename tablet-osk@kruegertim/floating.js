// Floating mode: move (drag the handle), resize (drag the grip), clamp, persist, opacity.
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {clampRect, resolveGeometry, resolveWidth, resizeWidth} from './floatingMath.js';

export {clampRect};

const DRAG_MOVE = 1;
const DRAG_RESIZE = 2;
const MOVE_THRESHOLD = 3; // px before a press counts as a drag (taps don't save)

export class FloatingController {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {Clutter.Actor} params.container         keyboard container (positioned in stage coords)
     * @param {() => Clutter.Actor} params.getGrabActor  keyboard handle (move bar)
     * @param {() => Clutter.Actor} params.getResizeGrip keyboard resize grip
     * @param {(geom:{x:number,y:number,width:number}) => void} params.onGeometryChanged
     *        called after the controller changed the container width/position; the coordinator
     *        recomputes key height for the new width and sets the container height.
     */
    constructor({settings, container, getGrabActor, getResizeGrip, onGeometryChanged}) {
        this._settings = settings;
        this._container = container;
        this._getGrabActor = getGrabActor;
        this._getResizeGrip = getResizeGrip;
        this._onGeometryChanged = onGeometryChanged ?? (() => {});

        this._enabled = false;
        this._drag = null;
        this._grabActor = null;
        this._resizeGrip = null;
        this._applying = false;
        this._saving = false;

        this._settings.connectObject(
            'changed::floating-opacity', () => this._applyOpacity(),
            'changed::floating-x', () => this._onStoredGeometryChanged(),
            'changed::floating-y', () => this._onStoredGeometryChanged(),
            'changed::floating-width', () => this._onStoredGeometryChanged(),
            this);
    }

    get enabled() {
        return this._enabled;
    }

    /** Current floating geometry {x, y, width, height} (clamped), computed from settings. */
    get geometry() {
        return this._computeGeometry();
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._bind();
        this._container.connectObject('notify::height', () => this._onHeightChanged(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this.reposition(), this);
        global.display.connectObject('workareas-changed', () => this.reposition(), this);
        this._applyOpacity();
        this.reposition();
    }

    disable() {
        if (!this._enabled)
            return;
        this._endDrag(false);
        this._unbind();
        this._container.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._enabled = false;
        this._container.opacity = 255;
    }

    /** Re-attach to the (possibly new) handle / grip after the keyboard rebuilt itself. */
    rebind() {
        if (!this._enabled)
            return;
        this._endDrag(false);
        this._unbind();
        this._bind();
    }

    /**
     * Apply the stored geometry (settings) clamped to the work area: sets container width and
     * position, then calls onGeometryChanged. Call after monitor changes or when entering floating mode.
     */
    reposition() {
        if (!this._enabled || this._drag)
            return;
        const g = this._computeGeometry();
        this._apply(g);
    }

    destroy() {
        this.disable();
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._container = null;
        this._getGrabActor = this._getResizeGrip = null;
        this._onGeometryChanged = null;
    }

    // ---- geometry -----------------------------------------------------------------------

    _monitorIndex() {
        return Main.layoutManager.primaryIndex;
    }

    _areas() {
        const index = this._monitorIndex();
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        let area = null;
        try {
            area = Main.layoutManager.getWorkAreaForMonitor(index);
        } catch (e) {
            area = null;
        }
        if (!area || area.width <= 0 || area.height <= 0)
            area = monitor;
        return {
            monitor: {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height},
            area: {x: area.x, y: area.y, width: area.width, height: area.height},
        };
    }

    _computeGeometry() {
        const {monitor, area} = this._areas();
        return resolveGeometry({
            x: this._settings.get_int('floating-x'),
            y: this._settings.get_int('floating-y'),
            width: this._settings.get_int('floating-width'),
            height: this._container.height,
        }, monitor, area);
    }

    _apply(g) {
        const c = this._container;
        this._applying = true;
        try {
            const widthChanged = Math.round(c.width) !== g.width;
            c.set_position(g.x, g.y);
            if (widthChanged)
                c.set_width(g.width);
            this._onGeometryChanged?.({x: g.x, y: g.y, width: g.width});
        } finally {
            this._applying = false;
        }
        // the coordinator may have changed the height → make sure we are still inside
        this._clampCurrent();
    }

    _clampCurrent() {
        const c = this._container;
        const {area} = this._areas();
        const r = clampRect({x: c.x, y: c.y, width: c.width, height: c.height}, area);
        if (r.x !== Math.round(c.x) || r.y !== Math.round(c.y))
            c.set_position(r.x, r.y);
    }

    _onHeightChanged() {
        if (this._applying)
            return;
        this._clampCurrent();
    }

    _onStoredGeometryChanged() {
        // external change (e.g. prefs "Position zurücksetzen"); our own saves are no-ops here
        if (this._enabled && !this._drag && !this._saving)
            this.reposition();
    }

    _applyOpacity() {
        if (!this._enabled || !this._container)
            return;
        const v = Math.min(1, Math.max(0.3, this._settings.get_double('floating-opacity')));
        this._container.opacity = Math.round(255 * v);
    }

    _save() {
        const c = this._container;
        this._saving = true;
        try {
            this._settings.set_int('floating-x', Math.round(c.x));
            this._settings.set_int('floating-y', Math.round(c.y));
            this._settings.set_int('floating-width', Math.round(c.width));
        } finally {
            this._saving = false;
        }
    }

    // ---- input --------------------------------------------------------------------------

    _bind() {
        this._grabActor = this._getGrabActor?.() ?? null;
        this._resizeGrip = this._getResizeGrip?.() ?? null;
        for (const [actor, kind] of [[this._grabActor, DRAG_MOVE], [this._resizeGrip, DRAG_RESIZE]]) {
            if (!actor)
                continue;
            actor.reactive = true;
            actor.connectObject(
                'button-press-event', (a, ev) => this._onPress(a, ev, kind),
                'touch-event', (a, ev) => this._onTouch(a, ev, kind),
                'motion-event', (a, ev) => this._onMotion(ev),
                'button-release-event', (a, ev) => this._onRelease(ev),
                'destroy', () => this._onActorDestroyed(),
                this);
        }
    }

    _unbind() {
        this._grabActor?.disconnectObject(this);
        this._resizeGrip?.disconnectObject(this);
        this._grabActor = this._resizeGrip = null;
    }

    _onActorDestroyed() {
        this._endDrag(false);
        this._unbind();
    }

    _startDrag(actor, event, kind) {
        if (this._drag || !this._enabled)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        const c = this._container;
        this._drag = {
            kind,
            actor,
            sequence: event.get_event_sequence(),
            startX: sx,
            startY: sy,
            x0: c.x,
            y0: c.y,
            w0: c.width,
            h0: c.height,
            moved: false,
            grab: global.stage.grab(actor),
        };
        return Clutter.EVENT_STOP;
    }

    _onPress(actor, event, kind) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;
        return this._startDrag(actor, event, kind);
    }

    _onTouch(actor, event, kind) {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN)
            return this._startDrag(actor, event, kind);

        const d = this._drag;
        if (!d || !d.sequence)
            return Clutter.EVENT_PROPAGATE;
        const seq = event.get_event_sequence();
        if (!seq || seq.get_slot() !== d.sequence.get_slot())
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_UPDATE)
            this._update(event);
        else if (type === Clutter.EventType.TOUCH_END)
            this._endDrag(true);
        else if (type === Clutter.EventType.TOUCH_CANCEL)
            this._endDrag(true);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._drag || this._drag.sequence)
            return Clutter.EVENT_PROPAGATE;
        this._update(event);
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._drag || this._drag.sequence)
            return Clutter.EVENT_PROPAGATE;
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this._endDrag(true);
        return Clutter.EVENT_STOP;
    }

    _update(event) {
        const d = this._drag;
        const [sx, sy] = event.get_coords();
        const dx = sx - d.startX;
        const dy = sy - d.startY;
        if (!d.moved && Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD)
            return;
        d.moved = true;

        const c = this._container;
        const {monitor, area} = this._areas();
        if (d.kind === DRAG_MOVE) {
            const r = clampRect({x: d.x0 + dx, y: d.y0 + dy, width: c.width, height: c.height}, area);
            c.set_position(r.x, r.y);
        } else {
            const width = resolveWidth(Math.max(1, resizeWidth(d.w0, d.h0, dx, dy)), monitor, area);
            if (width === Math.round(c.width))
                return;
            // keep the top-left corner; the coordinator sets the height for the new width
            this._applying = true;
            try {
                c.set_width(width);
                this._onGeometryChanged?.({x: Math.round(d.x0), y: Math.round(d.y0), width});
            } finally {
                this._applying = false;
            }
            const r = clampRect({x: d.x0, y: d.y0, width: c.width, height: c.height}, area);
            c.set_position(r.x, r.y);
        }
    }

    _endDrag(save) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        d.grab?.dismiss();
        if (save && d.moved && this._enabled) {
            this._clampCurrent();
            this._save();
        }
    }
}
