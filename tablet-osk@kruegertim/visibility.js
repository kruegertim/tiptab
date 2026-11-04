// SPDX-License-Identifier: GPL-2.0-or-later
// Auto-show/hide logic and swipe gestures for tablet-osk.
//
// Rules:
//  - "Text focus" = Main.inputMethod 'input-panel-state' ON (Wayland text-input / IBus
//    clients) or an editable Clutter.Text holding the stage key focus (shell entries).
//    Main.inputMethod has no focus-in/focus-out signals in GNOME 46 (only commit,
//    cursor-location-changed, delete-surrounding, input-panel-state, request-surrounding,
//    surrounding-text-set), so input-panel-state is the app-side trigger; the shell's
//    InputMethod emits OFF 50ms after focus-out.
//  - Focus-in shows (idle-debounced) when auto-show is allowed; the keyboard is then in
//    'auto' mode. Focus-out hides after HIDE_DELAY_MS unless text focus came back, but
//    only in 'auto' mode.
//  - Manual show (icon / swipe-up) puts it in 'manual' mode: it stays until a manual hide,
//    or until a focus-in (→ 'auto') is followed by a focus-out.
//  - A show of unknown origin (coordinator called show() itself) is treated like manual.
//  - Focus changes into the keyboard actor are ignored.
//  - Physical keyboard plugged in while auto-shown → hide; unplugged while a text field
//    has focus → auto-show.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {chromeParams} from './compat.js';

const LOG_PREFIX = '[tablet-osk]';

const HIDE_DELAY_MS = 400;     // focus-out debounce: Tab / tapping another field keeps the keyboard
const SUBMIT_WINDOW_MS = 700;  // after Enter: content cleared within this window => 'sent'
const TOGGLE_GRACE_MS = 300;   // TOGGLE right after a focus-in is treated as ON
const DRAG_THRESHOLD = 40;     // px, mouse strip + handle
const TOUCH_EDGE = 20;         // px from bottom edge where a touch swipe may start
const TOUCH_DISTANCE = 40;     // px the touch swipe must travel upwards
const STRIP_HEIGHT = 4;        // px, mouse bottom-edge strip
const SWIPE_ACTION_NAME = 'tablet-osk-swipe';

function allowedModes() {
    return Shell.ActionMode.ALL & ~Shell.ActionMode.LOCK_SCREEN;
}

function monitorRectAt(x, y) {
    const rect = new Mtk.Rectangle({x: x - 1, y: y - 1, width: 1, height: 1});
    const index = global.display.get_monitor_index_for_rect(rect);
    return global.display.get_monitor_geometry(index);
}

// Touch swipe up from the bottom edge.
//  - GNOME >= 49: Shell.EdgeDragGesture (the new Clutter.Gesture framework, used by the
//    shell's own OSK). Clutter.GestureAction/GestureTriggerEdge no longer exist there.
//  - GNOME 46-48: legacy Clutter.GestureAction subclass (modelled on EdgeDragAction).
// Both are Clutter.Actions with an 'enabled' property, added to global.stage.
let _LegacyBottomSwipeAction = null;

function _legacyBottomSwipeClass() {
    if (_LegacyBottomSwipeAction)
        return _LegacyBottomSwipeAction;
    // Defined lazily: `extends Clutter.GestureAction` throws at module load on GNOME >= 49.
    _LegacyBottomSwipeAction = GObject.registerClass({
        Signals: {'activated': {}},
    }, class TabletOskBottomSwipeAction extends Clutter.GestureAction {
        _init(canStart) {
            super._init();
            this._canStart = canStart;
            this.set_n_touch_points(1);
            this.set_threshold_trigger_edge(Clutter.GestureTriggerEdge.AFTER);
        }

        vfunc_gesture_prepare(_actor) {
            if (this.get_n_current_points() === 0)
                return false;
            // Pointer events have no sequence: mouse is handled by the bottom strip.
            if (!this.get_sequence(0))
                return false;
            if (!(allowedModes() & Main.actionMode))
                return false;
            if (!this._canStart())
                return false;

            const [x, y] = this.get_press_coords(0);
            const rect = monitorRectAt(x, y);
            return y > rect.y + rect.height - TOUCH_EDGE;
        }

        vfunc_gesture_progress(_actor) {
            const [startX, startY] = this.get_press_coords(0);
            const [x, y] = this.get_motion_coords(0);
            const offsetX = Math.abs(x - startX);
            const offsetY = Math.abs(y - startY);

            if (offsetX < TOUCH_EDGE && offsetY < TOUCH_EDGE)
                return true;

            if (offsetX > offsetY) {
                this.cancel();
                return false;
            }
            return true;
        }

        vfunc_gesture_end(_actor) {
            const [, startY] = this.get_press_coords(0);
            const [, y] = this.get_motion_coords(0);
            if (startY - y > TOUCH_DISTANCE)
                this.emit('activated');
            else
                this.cancel();
        }
    });
    return _LegacyBottomSwipeAction;
}

// Returns {actor, phase, onActivated(cb)}; cb runs when a swipe-up completes.
function createBottomSwipe(canStart) {
    if (typeof Shell.EdgeDragGesture === 'function') {
        const gesture = new Shell.EdgeDragGesture({
            name: 'tablet-osk bottom swipe',
            side: St.Side.BOTTOM,
        });
        gesture.connect('may-recognize', () =>
            !!(allowedModes() & Main.actionMode) && !!canStart());
        return {
            actor: gesture,
            phase: null,
            onActivated: cb => gesture.connect('end', cb),
        };
    }
    const action = new (_legacyBottomSwipeClass())(canStart);
    return {
        actor: action,
        phase: Clutter.EventPhase.CAPTURE,
        onActivated: cb => action.connect('activated', cb),
    };
}

// Press + vertical drag recogniser for a single actor (mouse and optionally touch),
// using a stage grab while the drag is in progress. A plain tap does nothing.
class DragRecognizer {
    // direction: -1 = up, +1 = down
    constructor({direction, threshold = DRAG_THRESHOLD, touch = true, shouldStart, onTrigger}) {
        this._direction = direction;
        this._threshold = threshold;
        this._touch = touch;
        this._shouldStart = shouldStart;
        this._onTrigger = onTrigger;
        this._actor = null;
        this._grab = null;
        this._active = false;
        this._isTouch = false;
        this._startY = 0;
    }

    get actor() {
        return this._actor;
    }

    attach(actor) {
        this.detach();
        if (!actor)
            return;
        this._actor = actor;
        actor.reactive = true;
        actor.connectObject(
            'button-press-event', (a, e) => this._onButtonPress(e),
            'motion-event', (a, e) => this._onMotion(e),
            'button-release-event', (a, e) => this._onButtonRelease(e),
            'touch-event', (a, e) => this._onTouch(e),
            'destroy', () => {
                this._end();
                this._actor = null;
            },
            this);
    }

    detach() {
        this._end();
        this._actor?.disconnectObject(this);
        this._actor = null;
    }

    _begin(event, isTouch) {
        const [, y] = event.get_coords();
        this._startY = y;
        this._isTouch = isTouch;
        this._active = true;
        try {
            this._grab = global.stage.grab(this._actor);
        } catch (e) {
            console.error(`${LOG_PREFIX} grab failed: ${e}`);
            this._grab = null;
        }
    }

    _update(event) {
        const [, y] = event.get_coords();
        if ((y - this._startY) * this._direction > this._threshold) {
            this._end();
            try {
                this._onTrigger();
            } catch (e) {
                console.error(`${LOG_PREFIX} swipe handler failed: ${e}`);
            }
        }
    }

    _end() {
        this._active = false;
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
    }

    _onButtonPress(event) {
        if (this._active || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (!this._shouldStart(event))
            return Clutter.EVENT_PROPAGATE;
        this._begin(event, false);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._active || this._isTouch)
            return Clutter.EVENT_PROPAGATE;
        this._update(event);
        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(event) {
        if (!this._active || this._isTouch || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._end();
        return Clutter.EVENT_STOP;
    }

    _onTouch(event) {
        if (!this._touch)
            return Clutter.EVENT_PROPAGATE;
        switch (event.type()) {
        case Clutter.EventType.TOUCH_BEGIN:
            if (this._active || !this._shouldStart(event))
                return Clutter.EVENT_PROPAGATE;
            this._begin(event, true);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_UPDATE:
            if (!this._active || !this._isTouch)
                return Clutter.EVENT_PROPAGATE;
            this._update(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_END:
        case Clutter.EventType.TOUCH_CANCEL:
            if (!this._active || !this._isTouch)
                return Clutter.EVENT_PROPAGATE;
            this._end();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    destroy() {
        this.detach();
        this._onTrigger = null;
        this._shouldStart = null;
    }
}

export class VisibilityController {
    constructor({settings, show, hide, isVisible, getHandle, getKeyboardActor, physicalKeyboard,
        modalBridge = null}) {
        this._submitTag = {};
        this._submitId = 0;
        this._settings = settings;
        this._show = show;
        this._hide = hide;
        this._isVisible = isVisible;
        this._getHandle = getHandle;
        this._getKeyboardActor = getKeyboardActor;
        this._physicalKeyboard = physicalKeyboard;
        this._modalBridge = modalBridge;

        this._mode = null;          // null | 'auto' | 'manual'
        this._imeWants = false;
        this._shellText = false;
        this._lastFocusIn = 0;
        this._showId = 0;
        this._hideId = 0;
        this._keyboardActor = null;

        this._shellText = this._isEditableText(global.stage.key_focus) &&
            !this._inKeyboard(global.stage.key_focus);

        Main.inputMethod.connectObject('input-panel-state',
            (_im, state) => this._onPanelState(state), this);
        global.stage.connectObject('notify::key-focus',
            () => this._onKeyFocusChanged(), this);

        this._settings.connectObject(
            'changed::swipe-gestures', () => this._syncVisibleState(),
            'changed::ignore-physical-keyboard', () => this._onPhysicalKeyboardChanged(),
            'changed::auto-show', () => this._onPhysicalKeyboardChanged(),
            this);

        this._pkListener = null;
        if (typeof this._physicalKeyboard?.addListener === 'function') {
            this._pkListener = this._physicalKeyboard.addListener(
                () => this._onPhysicalKeyboardChanged());
        }

        // Touch: swipe up from the bottom edge (stage, capture phase)
        const swipe = createBottomSwipe(
            () => this._swipeEnabled() && !this._safeIsVisible());
        swipe.onActivated(() => this.manualShow());
        this._swipeAction = swipe.actor;
        if (swipe.phase !== null)
            global.stage.add_action_full(SWIPE_ACTION_NAME, swipe.phase, this._swipeAction);
        else
            global.stage.add_action(this._swipeAction);

        // Mouse: thin reactive strip at the bottom edge of the primary monitor
        this._strip = new St.Widget({
            name: 'tabletOskSwipeStrip',
            reactive: true,
            track_hover: false,
        });
        Main.layoutManager.addTopChrome(this._strip, chromeParams({affectsInputRegion: true}));
        this._stripDrag = new DragRecognizer({
            direction: -1,
            touch: false,
            shouldStart: () => this._swipeEnabled() && !this._safeIsVisible() &&
                (allowedModes() & Main.actionMode) !== 0,
            onTrigger: () => this.manualShow(),
        });
        this._stripDrag.attach(this._strip);
        // While a modal dialog grabs the input, the stage swipe action and the strip get
        // no events; the bridge forwards them (strip) or asks us (touch edge swipe).
        this._modalEdge = null;
        this._modalEdgeHandler = event => this._onModalEdgeEvent(event);
        this._modalBridge?.addRoot(this._strip);
        this._modalBridge?.addHandler(this._modalEdgeHandler);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._positionStrip(), this);
        this._positionStrip();

        // Handle: swipe down hides (docked mode only)
        this._handleDrag = new DragRecognizer({
            direction: 1,
            touch: true,
            shouldStart: event => this._handleSwipeAllowed(event),
            onTrigger: () => this.manualHide(),
        });

        this.rebindHandle();
        this._syncVisibleState();
    }

    // Touch swipe up from the bottom edge while a modal dialog holds the grab
    // (the stage gesture is cut off then). Not on the lock screen: there a swipe up
    // reveals the password prompt, whose entry then auto-shows the keyboard anyway.
    _onModalEdgeEvent(event) {
        const T = Clutter.EventType;
        const type = event.type();
        const [x, y] = event.get_coords();
        if (type === T.TOUCH_BEGIN) {
            this._modalEdge = null;
            if (!this._swipeEnabled() || this._safeIsVisible() || Main.sessionMode.isLocked)
                return false;
            const m = monitorRectAt(x, y);
            if (y < m.y + m.height - TOUCH_EDGE)
                return false;
            this._modalEdge = {y0: y, done: false};
            return true;
        }
        const st = this._modalEdge;
        if (!st)
            return false;
        if (type === T.TOUCH_UPDATE && !st.done && st.y0 - y > TOUCH_DISTANCE) {
            st.done = true;
            this.manualShow();
        } else if (type === T.TOUCH_END || type === T.TOUCH_CANCEL) {
            this._modalEdge = null;
        }
        return true;
    }

    // ---- public API (beyond the contract; coordinator should use these) ----

    // Toggle from the panel icon (manual).
    toggle() {
        if (this._safeIsVisible())
            this.manualHide();
        else
            this.manualShow();
    }

    manualShow() {
        this._cancelTimers();
        if (!this._safeIsVisible())
            this._doShow('manual');
    }

    manualHide() {
        this._cancelTimers();
        if (this._safeIsVisible())
            this._doHide();
        else
            this._mode = null;
    }

    // Call after the keyboard was rebuilt (new handle actor).
    rebindHandle() {
        const handle = this._safeCall(this._getHandle);
        if (handle !== this._handleDrag.actor)
            this._handleDrag.attach(handle ?? null);

        const ka = this._safeCall(this._getKeyboardActor);
        if (ka !== this._keyboardActor) {
            this._keyboardActor?.disconnectObject(this);
            this._keyboardActor = ka ?? null;
            this._keyboardActor?.connectObject(
                'notify::visible', () => this._syncVisibleState(),
                'destroy', () => {
                    this._keyboardActor = null;
                },
                this);
        }
    }

    // Call after show()/hide() initiated outside this controller (e.g. hide key).
    notifyVisibleChanged() {
        this._syncVisibleState();
    }

    // Alternative to the listener hook, if the coordinator forwards it.
    onPhysicalKeyboardChanged() {
        this._onPhysicalKeyboardChanged();
    }

    // ---- helpers ----

    _safeCall(fn) {
        try {
            return fn?.() ?? null;
        } catch (e) {
            console.error(`${LOG_PREFIX} callback failed: ${e}`);
            return null;
        }
    }

    _safeIsVisible() {
        return !!this._safeCall(this._isVisible);
    }

    _isShown() {
        const shown = this._safeIsVisible();
        if (!shown)
            this._mode = null;
        return shown;
    }

    _swipeEnabled() {
        return this._settings.get_boolean('swipe-gestures');
    }

    _isFloating() {
        try {
            return this._settings.get_string('mode') === 'floating';
        } catch {
            return false;   // key not present
        }
    }

    _autoAllowed() {
        if (!this._settings.get_boolean('auto-show'))
            return false;
        if (this._settings.get_boolean('ignore-physical-keyboard'))
            return true;
        return !this._physicalKeyboard?.present;
    }

    _wanted() {
        return this._imeWants || this._shellText;
    }

    _isEditableText(focus) {
        return focus instanceof Clutter.Text && focus.editable;
    }

    _inKeyboard(focus) {
        if (!focus)
            return false;
        const ka = this._safeCall(this._getKeyboardActor);
        return !!ka && (ka === focus || ka.contains(focus));
    }

    // Only react to presses that start on the handle itself or on non-reactive
    // children (e.g. the grip pill), never on child buttons (gear).
    _handleSwipeAllowed(event) {
        if (!this._swipeEnabled() || this._isFloating() || !this._safeIsVisible())
            return false;
        const handle = this._handleDrag.actor;
        let source = global.stage.get_event_actor(event);
        if (!handle || !source)
            return false;
        if (!handle.contains(source))
            return false;
        while (source && source !== handle) {
            if (source.reactive)
                return false;
            source = source.get_parent();
        }
        return true;
    }

    _positionStrip() {
        if (!this._strip)
            return;
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        this._strip.set_position(m.x, m.y + m.height - STRIP_HEIGHT);
        this._strip.set_size(m.width, STRIP_HEIGHT);
    }

    _syncVisibleState() {
        const visible = this._isShown();
        const swipe = this._swipeEnabled();
        if (this._swipeAction)
            this._swipeAction.enabled = swipe && !visible;
        if (this._strip)
            this._strip.visible = swipe && !visible;
        if (visible && this._strip)
            this._stripDrag?._end();
    }

    // isVisible() is expected to report the target state right after show()/hide().
    _doShow(mode) {
        this._safeCall(this._show);
        this._syncVisibleState();
        this._mode = mode;
    }

    _doHide() {
        this._mode = null;
        this._safeCall(this._hide);
        this._syncVisibleState();
    }

    _cancelTimers() {
        if (this._showId) {
            GLib.source_remove(this._showId);
            this._showId = 0;
        }
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }

    // ---- smart auto-hide after submit / Escape ----

    // Called by the coordinator for special keys the OSK sent (keysym names).
    onKeySent(name) {
        if (this._mode !== 'auto' || !this._isShown() ||
            !this._settings.get_boolean('hide-after-submit'))
            return;
        if (name === 'Escape') {
            this._cancelTimers();
            this._doHide();
            return;
        }
        if (name !== 'Return' && name !== 'KP_Enter')
            return;
        const shellText = this._isEditableText(global.stage.key_focus) ? global.stage.key_focus : null;
        if (shellText ? !shellText.single_line_mode
            : (Main.inputMethod.content_hints & Clutter.InputContentHintFlags.MULTILINE))
            return; // multi-line: Enter is just a newline
        this._clearSubmit();
        this._submitShellText = shellText;
        this._submitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBMIT_WINDOW_MS, () => {
            this._submitId = 0;
            this._checkSubmitCleared(true);
            this._submitShellText = null;
            return GLib.SOURCE_REMOVE;
        });
        // Apps report the new (possibly empty) content via surrounding text shortly after.
        Main.inputMethod.connectObject('surrounding-text-set',
            () => this._checkSubmitCleared(false), this._submitTag);
    }

    _checkSubmitCleared(final) {
        if (!this._submitId && !final)
            return;
        const st = this._submitShellText;
        const text = st ? st.text : Main.inputMethod._surroundingText;
        if (typeof text === 'string' && text.length === 0 && this._mode === 'auto' && this._isShown()) {
            this._clearSubmit();
            this._cancelTimers();
            this._doHide();
        } else if (final) {
            this._clearSubmit();
        }
    }

    _clearSubmit() {
        if (this._submitId) {
            GLib.source_remove(this._submitId);
            this._submitId = 0;
        }
        Main.inputMethod.disconnectObject(this._submitTag);
    }

    // ---- focus tracking ----

    _onKeyFocusChanged() {
        const focus = global.stage.key_focus;
        if (this._inKeyboard(focus))
            return;
        const isText = this._isEditableText(focus);
        const was = this._shellText;
        this._shellText = isText;
        if (isText)
            this._focusIn();
        else if (was)
            this._focusOut();
    }

    _onPanelState(state) {
        switch (state) {
        case Clutter.InputPanelState.ON:
            this._imeWants = true;
            this._focusIn();
            break;
        case Clutter.InputPanelState.OFF:
            this._imeWants = false;
            this._focusOut();
            break;
        case Clutter.InputPanelState.TOGGLE: {
            const recent = GLib.get_monotonic_time() / 1000 - this._lastFocusIn < TOGGLE_GRACE_MS;
            if (this._isShown() && !this._showId && !recent) {
                // Explicit user toggle on an already focused field
                if (this._autoAllowed()) {
                    this._cancelTimers();
                    this._doHide();
                }
            } else {
                this._imeWants = true;
                this._focusIn();
            }
            break;
        }
        }
    }

    _focusIn() {
        this._lastFocusIn = GLib.get_monotonic_time() / 1000;
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (!this._autoAllowed())
            return;
        if (this._isShown()) {
            // A manually opened keyboard is never auto-hidden (Tim's rule).
            if (this._mode !== 'manual')
                this._mode = 'auto';
            return;
        }
        if (this._showId)
            return;
        this._showId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._showId = 0;
            if (!this._wanted() || !this._autoAllowed())
                return GLib.SOURCE_REMOVE;
            if (this._isShown()) {
                if (this._mode !== 'manual')
                    this._mode = 'auto';
            } else {
                this._doShow('auto');
            }
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._showId, '[tablet-osk] auto show');
    }

    _focusOut() {
        if (this._wanted())
            return;
        if (this._showId) {
            GLib.source_remove(this._showId);
            this._showId = 0;
        }
        if (this._hideId)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            this._hideId = 0;
            if (this._wanted())
                return GLib.SOURCE_REMOVE;
            if (this._isShown() && this._mode === 'auto')
                this._doHide();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._hideId, '[tablet-osk] auto hide');
    }

    _onPhysicalKeyboardChanged() {
        const shown = this._isShown();
        if (!this._autoAllowed()) {
            const pkBlocks = this._physicalKeyboard?.present &&
                !this._settings.get_boolean('ignore-physical-keyboard');
            if (pkBlocks && shown && this._mode === 'auto') {
                this._cancelTimers();
                this._doHide();
            }
            return;
        }
        if (!shown && this._wanted())
            this._focusIn();
    }

    destroy() {
        this._clearSubmit();
        this._cancelTimers();

        Main.inputMethod.disconnectObject(this);
        global.stage.disconnectObject(this);
        this._settings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);

        if (this._pkListener)
            this._physicalKeyboard?.removeListener?.(this._pkListener);
        this._pkListener = null;

        if (this._swipeAction) {
            global.stage.remove_action(this._swipeAction);
            this._swipeAction = null;
        }

        this._stripDrag?.destroy();
        this._stripDrag = null;
        this._modalBridge?.removeHandler(this._modalEdgeHandler);
        if (this._strip)
            this._modalBridge?.removeRoot(this._strip);
        this._modalBridge = null;
        if (this._strip) {
            Main.layoutManager.removeChrome(this._strip);
            this._strip.destroy();
            this._strip = null;
        }

        this._handleDrag?.destroy();
        this._handleDrag = null;

        this._keyboardActor?.disconnectObject(this);
        this._keyboardActor = null;

        this._settings = null;
        this._show = this._hide = this._isVisible = null;
        this._getHandle = this._getKeyboardActor = null;
        this._physicalKeyboard = null;
    }
}
