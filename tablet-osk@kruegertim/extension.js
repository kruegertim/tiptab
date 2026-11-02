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

const ANIMATION_TIME = 200;
const MIN_FLOATING_KEY_MM = 6;

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
        km._syncEnabled();
        if (km._bottomDragAction) {
            this._origDragEnabled = km._bottomDragAction.enabled;
            km._bottomDragAction.enabled = false;
            this._dragNotifyId = km._bottomDragAction.connect('notify::enabled', a => {
                if (a.enabled)
                    a.enabled = false;
            });
        }
    }

    _restoreBuiltinOsk() {
        const km = Main.keyboard;
        if (!km || !this._origSyncEnabled)
            return;
        if (km._bottomDragAction) {
            if (this._dragNotifyId)
                km._bottomDragAction.disconnect(this._dragNotifyId);
            km._bottomDragAction.enabled = this._origDragEnabled ?? true;
        }
        this._dragNotifyId = 0;
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
    }

    _applyFloatingHeight(width) {
        const monitor = this._monitor();
        if (!monitor || !this._keyboard)
            return;
        const minPx = this._metrics.keyHeightPx(Main.layoutManager.primaryIndex, MIN_FLOATING_KEY_MM);
        const keyPx = Math.max(minPx, Math.round(this._dockedKeyPx() * width / monitor.width));
        this._keyboard.setKeyHeight(keyPx);
        this._container.height = Math.round(this._keyboard.preferredHeight);
    }

    _relayout() {
        if (!this._container)
            return;
        const monitor = this._monitor();
        if (!monitor)
            return;

        if (this._isFloating) {
            const width = this._floating.geometry?.width ?? Math.round(monitor.width * 0.7);
            this._applyFloatingHeight(width);
            this._floating.reposition();
            return;
        }

        this._keyboard.setKeyHeight(this._dockedKeyPx());
        const height = Math.min(Math.round(this._keyboard.preferredHeight),
            Math.round(monitor.height * 0.6));
        this._container.set_size(monitor.width, height);
        this._container.set_position(monitor.x, monitor.y + monitor.height - height);
        if (!this._visible)
            this._container.translation_y = height;
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
