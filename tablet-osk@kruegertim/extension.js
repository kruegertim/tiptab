// Tablet OSK — GNOME Shell 46 extension entry point (integration of all modules).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OskKeyboard} from './keyboard.js';
import {MonitorMetrics, WorkArea} from './workarea.js';
import {PhysicalKeyboardMonitor} from './physicalKeyboard.js';
import {PanelIndicator} from './indicator.js';
import {VisibilityController} from './visibility.js';
import {SettingsPanel} from './settingsPanel.js';
import {FloatingController} from './floating.js';
import {DockMover} from './dock.js';
import {PredictController} from './predictController.js';
import {SPLIT_TOTAL_UNITS, SPLIT_LEFT_UNITS, SPLIT_GAP_UNITS} from './layouts.js';

const ANIMATION_TIME = 200;
const MIN_FLOATING_KEY_MM = 6;
// Key aspect ratio reference: at this key height the docked keyboard spans the full
// screen width. Lower key heights make the keyboard narrower instead of the keys
// flatter (same width/height ratio as at 13 mm).
const REFERENCE_KEY_MM = 13;

export default class TabletOskExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._visible = false;
        this._dockMover = new DockMover(this._settings);

        this._suppressBuiltinOsk();

        this._container = new St.Widget({
            name: 'tabletOskContainer',
            style_class: 'tosk-container',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            visible: false,
        });
        // WorkArea adds the container to the chrome (uiGroup) itself.
        this._workArea = new WorkArea(this._container, this._settings);

        this._keyboard = new OskKeyboard({settings: this._settings});
        this._keyboard.x_expand = true;
        this._keyboard.y_expand = true;
        this._container.add_child(this._keyboard);
        this._predict = new PredictController({
            settings: this._settings,
            keyboard: this._keyboard,
            extensionPath: this.path,
        });

        this._metrics = new MonitorMetrics(() => this._relayout(), this._settings);

        this._panel = null; // created lazily on first gear tap (needs to be on stage)

        this._keyboard.connectObject(
            'hide-request', () => {
                this._hide();
                this._visibility?.notifyVisibleChanged();
            },
            'settings-request', () => this._setPanelVisible(!this._panel?.visible),
            'layout-changed', () => this._afterRebuild(),
            'key-sent', (_k, name) => this._visibility?.onKeySent(name),
            'swipe-progress', (_k, dy) => {
                if (this._visible && this._container)
                    this._container.translation_y = Math.max(0, dy);
            },
            'swipe-cancel', () => {
                this._container?.ease({
                    translation_y: 0,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
            'swipe-hide', () => {
                this._hide();
                this._visibility?.notifyVisibleChanged();
            },
            this);

        this._floating = new FloatingController({
            settings: this._settings,
            container: this._container,
            getGrabActor: () => this._keyboard.handle,
            getResizeGrip: () => this._keyboard.resizeGrip,
            onGeometryChanged: ({width}) => this._applyFloatingHeight(width),
        });

        this._physical = new PhysicalKeyboardMonitor(() => {});

        this._visibility = new VisibilityController({
            settings: this._settings,
            show: () => this._show(),
            hide: () => this._hide(),
            isVisible: () => this._visible,
            getHandle: () => this._keyboard.handle,
            getKeyboardActor: () => this._container,
            physicalKeyboard: this._physical,
        });

        this._indicator = new PanelIndicator({
            settings: this._settings,
            uuid: this.uuid,
            onToggle: () => this._visibility.toggle(),
        });

        this._settings.connectObject(
            'changed::key-height-mm', () => this._relayout(),
            'changed::keep-key-aspect', () => this._relayout(),
            'changed::thumb-key-height-mm', () => this._relayout(),
            'changed::show-f-row', () => this._afterRebuild(),
            'changed::layout', () => this._afterRebuild(),
            'changed::mode', () => this._applyMode(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);

        this._applyMode();
    }

    disable() {
        this._settings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        if (this._relayoutId) {
            GLib.source_remove(this._relayoutId);
            this._relayoutId = 0;
        }

        this._predict?.destroy();
        this._predict = null;
        this._visibility?.destroy();
        this._indicator?.destroy();
        this._physical?.destroy();
        this._floating?.destroy();
        this._metrics?.destroy();
        this._container?.remove_all_transitions();
        this._workArea?.destroy();
        this._keyboard?.disconnectObject(this);
        this._panel?.disconnectObject(this);
        this._container?.destroy(); // also destroys keyboard + panel
        this._visibility = this._indicator = this._physical = this._metrics = null;
        this._floating = this._panel = this._workArea = this._keyboard = this._container = null;

        this._dockMover?.destroy();
        this._dockMover = null;
        this._restoreBuiltinOsk();
        this._settings = null;
    }

    // ---- built-in GNOME OSK suppression -------------------------------------------------

    _suppressBuiltinOsk() {
        const km = Main.keyboard; // KeyboardManager
        if (!km)
            return;
        this._origSyncEnabled = km._syncEnabled;
        // The built-in OSK auto-enables on touch input; it would fight with ours.
        km._syncEnabled = function () {
            if (this._keyboard) {
                this._keyboard.setCursorLocation?.(null);
                this._keyboard.destroy();
                this._keyboard = null;
                this.emit('visibility-changed');
            }
        };
        // KeyboardManager connects its signal handlers with this._syncEnabled.bind(this),
        // i.e. to the original method, so the override above only covers direct calls.
        // The original looks _lastDeviceIsTouchscreen() up on the instance, so shadowing
        // it keeps touch input from auto-creating the built-in keyboard.
        this._origLastDeviceIsTouchscreen = Object.hasOwn(km, '_lastDeviceIsTouchscreen')
            ? km._lastDeviceIsTouchscreen : null;
        km._lastDeviceIsTouchscreen = () => false;
        km._syncEnabled();
        // GNOME 46-48: _bottomDragAction (Clutter.GestureAction); GNOME 49+: _bottomDragGesture
        // (Shell.EdgeDragGesture). Keep it disabled so it doesn't compete with our swipe.
        this._builtinDrag = km._bottomDragGesture ?? km._bottomDragAction ?? null;
        if (this._builtinDrag) {
            this._origDragEnabled = this._builtinDrag.enabled;
            this._builtinDrag.enabled = false;
            this._dragNotifyId = this._builtinDrag.connect('notify::enabled', a => {
                if (a.enabled)
                    a.enabled = false;
            });
        }
    }

    _restoreBuiltinOsk() {
        const km = Main.keyboard;
        if (!km || !this._origSyncEnabled)
            return;
        if (this._builtinDrag) {
            if (this._dragNotifyId)
                this._builtinDrag.disconnect(this._dragNotifyId);
            this._builtinDrag.enabled = this._origDragEnabled ?? true;
        }
        this._builtinDrag = null;
        this._dragNotifyId = 0;
        if (this._origLastDeviceIsTouchscreen)
            km._lastDeviceIsTouchscreen = this._origLastDeviceIsTouchscreen;
        else
            delete km._lastDeviceIsTouchscreen;
        this._origLastDeviceIsTouchscreen = null;
        km._syncEnabled = this._origSyncEnabled;
        this._origSyncEnabled = null;
        km._syncEnabled();
    }

    // ---- geometry -----------------------------------------------------------------------

    get _isFloating() {
        return this._settings.get_string('mode') === 'floating';
    }

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _dockedKeyPx() {
        return this._metrics.keyHeightPx(Main.layoutManager.primaryIndex,
            this._settings.get_double('key-height-mm'));
    }

    // 0 when the keep-key-aspect setting is off (old behaviour: full width, flatter keys).
    _referenceKeyPx() {
        if (!this._settings.get_boolean('keep-key-aspect'))
            return 0;
        return this._metrics.keyHeightPx(Main.layoutManager.primaryIndex, REFERENCE_KEY_MM);
    }

    _applyMode() {
        if (!this._container)
            return;
        const floating = this._isFloating;
        this._keyboard.setFloating(floating);
        if (floating) {
            this._dockMover.restore();
            this._container.translation_y = 0;
            this._floating.enable();
        } else {
            this._floating.disable();
            if (this._visible)
                this._dockMover.moveAway();
        }
        // WorkArea watches 'mode' itself and drops the strut while floating.
        this._relayout();
        // The handle getter is null when docked, the grab bar when floating.
        this._visibility?.rebindHandle();
        this._floating.rebind();
    }

    _applyFloatingHeight(width) {
        const monitor = this._monitor();
        if (!monitor || !this._keyboard)
            return;
        const minPx = this._metrics.keyHeightPx(Main.layoutManager.primaryIndex, MIN_FLOATING_KEY_MM);
        // Same key aspect ratio as docked: never flatter than at REFERENCE_KEY_MM.
        const dockedPx = Math.max(this._dockedKeyPx(), this._referenceKeyPx());
        const keyPx = Math.max(minPx, Math.round(dockedPx * width / monitor.width));
        this._keyboard.setKeyHeight(keyPx);
        this._container.height = Math.round(this._keyboard.preferredHeight);
    }

    _relayout() {
        if (!this._container)
            return;
        const monitor = this._monitor();
        if (!monitor)
            return;

        // Thumb mode (split keyboard) only in landscape; portrait falls back to docked.
        const thumb = !this._isFloating && this._settings.get_string('mode') === 'thumb' &&
            monitor.width > monitor.height;
        this._keyboard.setThumb(thumb);
        this._container.reactive = !thumb;
        if (thumb)
            this._container.add_style_class_name('tosk-container-thumb');
        else
            this._container.remove_style_class_name('tosk-container-thumb');
        this._syncThumbHalves(thumb, monitor);

        if (this._isFloating) {
            this._keyboard.setPickSpans(null);
            this._keyboard.setSideInset(0);
            this._keyboard.width = -1;
            this._keyboard.x_align = Clutter.ActorAlign.FILL;
            const width = this._floating.geometry?.width ?? Math.round(monitor.width * 0.7);
            this._applyFloatingHeight(width);
            this._floating.reposition();
            return;
        }

        const keyPx = thumb
            ? this._metrics.keyHeightPx(Main.layoutManager.primaryIndex,
                this._settings.get_double('thumb-key-height-mm'))
            : this._dockedKeyPx();
        this._keyboard.setKeyHeight(keyPx);
        // Below the reference height the keys get a side inset (centred, narrower key
        // area), keeping the key aspect ratio; the keyboard itself stays full width.
        const refPx = thumb ? 0 : this._referenceKeyPx();
        this._keyboard.width = -1;
        this._keyboard.x_align = Clutter.ActorAlign.FILL;
        if (!thumb)
            this._keyboard.setPickSpans(null);
        const kbW = keyPx < refPx ? Math.round(monitor.width * keyPx / refPx) : monitor.width;
        this._keyboard.setSideInset((monitor.width - kbW) / 2);
        const height = Math.min(Math.round(this._keyboard.preferredHeight),
            Math.round(monitor.height * 0.6));
        this._container.set_size(monitor.width, height);
        this._container.set_position(monitor.x, monitor.y + monitor.height - height);
        if (thumb)
            this._layoutThumbHalves(monitor.width);
        if (!this._visible)
            this._container.translation_y = height;
    }

    // Thumb mode: background panels behind the two halves (visual only; the keyboard
    // picks the half areas itself); the middle third stays free for the app.
    _syncThumbHalves(thumb, _monitor) {
        if (!thumb) {
            this._thumbHalves?.forEach(w => w.hide());
            this._keyboard.setBarWidth(-1);
            return;
        }
        if (!this._thumbHalves) {
            this._thumbHalves = [Clutter.ActorAlign.START, Clutter.ActorAlign.END].map(align => {
                const w = new St.Widget({
                    style_class: 'tosk-thumb-half',
                    reactive: false, // visual only; the keyboard picks the half areas
                    x_align: align,
                    x_expand: true, // BinLayout honours x_align only for expanding children
                    y_expand: true,
                });
                this._container.insert_child_below(w, this._keyboard);
                return w;
            });
        }
        this._thumbHalves.forEach(w => w.show());
    }

    _layoutThumbHalves(width) {
        const kb = this._keyboard;
        const pad = kb._pad, gap = kb._gap;
        const unit = (width - 2 * pad + gap) / SPLIT_TOTAL_UNITS;
        const leftEnd = pad + Math.round(SPLIT_LEFT_UNITS * unit) - gap;
        const rightStart = pad + Math.round((SPLIT_LEFT_UNITS + SPLIT_GAP_UNITS) * unit);
        const [left, right] = this._thumbHalves;
        left.width = leftEnd + pad;
        right.width = width - rightStart + pad;
        kb.setPickSpans([[0, leftEnd + pad], [rightStart - pad, width]]);
        // Suggestion strip over the gap between the halves.
        kb.setBarWidth(Math.max(0, rightStart - leftEnd - 2 * pad), (leftEnd + rightStart - width) / 2);
    }

    _afterRebuild() {
        // keyboard.js rebuilds itself on these settings; re-apply sizes and handle bindings.
        if (this._relayoutId)
            return;
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relayoutId = 0;
            this._keyboard?.setFloating(this._isFloating);
            this._relayout();
            this._visibility?.rebindHandle();
            this._floating?.rebind();
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensurePanel() {
        if (this._panel)
            return;
        this._panel = new SettingsPanel({
            settings: this._settings,
            pxPerMm: () => this._metrics.pxPerMm(Main.layoutManager.primaryIndex),
        });
        this._panel.x_expand = true;
        this._panel.y_expand = true;
        this._panel.visible = false;
        this._container.add_child(this._panel);
        this._panel.connectObject('close-request', () => this._setPanelVisible(false), this);
    }

    _setPanelVisible(visible) {
        if (!visible && !this._panel)
            return;
        this._ensurePanel();
        this._panel.visible = visible;
        this._keyboard.opacity = visible ? 0 : 255;
        this._keyboard.reactive = !visible;
    }

    // ---- show / hide --------------------------------------------------------------------

    // Keep the keyboard above all other chrome (dock, panels added later by extensions).
    _raise() {
        const parent = this._container?.get_parent();
        if (parent)
            parent.set_child_above_sibling(this._container, null);
    }

    _show() {
        if (!this._container || this._visible)
            return;
        this._visible = true;
        this._relayout();
        const c = this._container;
        c.remove_all_transitions();
        this._indicator?.setActive(true);

        if (this._isFloating) {
            c.translation_y = 0;
            c.opacity = 0;
            c.show();
            this._raise();
            // WorkArea ignores this while floating, but needs it to reserve space
            // if the mode is switched to docked while the keyboard is shown.
            this._workArea.setShown(true);
            c.ease({
                opacity: Math.round(255 * this._settings.get_double('floating-opacity')),
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }

        c.translation_y = c.height;
        this._dockMover.moveAway();
        c.show();
        this._raise();
        this._workArea.setShown(true);
        c.ease({
            translation_y: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hide() {
        if (!this._container || !this._visible)
            return;
        this._visible = false;
        this._keyboard.resetModifiers();
        this._setPanelVisible(false);
        this._indicator?.setActive(false);
        const c = this._container;
        c.remove_all_transitions();

        const done = () => {
            if (this._visible || !this._container)
                return;
            c.hide();
            this._workArea.setShown(false);
            this._dockMover?.restore();
            if (this._isFloating)
                c.opacity = Math.round(255 * this._settings.get_double('floating-opacity'));
        };

        if (this._isFloating) {
            c.ease({
                opacity: 0,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: done,
            });
            return;
        }

        c.ease({
            translation_y: c.height,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: done,
        });
    }
}
