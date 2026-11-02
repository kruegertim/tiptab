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

const ANIMATION_TIME = 200;

export default class TabletOskExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._visible = false;

        this._suppressBuiltinOsk();

        this._container = new St.Widget({
            name: 'tabletOskContainer',
            style_class: 'tosk-container',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            visible: false,
        });
        this._keyboard = new OskKeyboard({settings: this._settings});
        this._keyboard.x_expand = true;
        this._keyboard.y_expand = true;
        this._container.add_child(this._keyboard);
        this._keyboard.connectObject('hide-request', () => this._hide(), this);

        this._workArea = new WorkArea(this._container, this._settings);
        this._metrics = new MonitorMetrics(() => this._relayout());

        this._physical = new PhysicalKeyboardMonitor(() => {});

        this._indicator = new PanelIndicator({
            settings: this._settings,
            onToggle: () => this._toggle(),
        });

        this._visibility = new VisibilityController({
            settings: this._settings,
            show: () => this._show(),
            hide: () => this._hide(),
            isVisible: () => this._visible,
            getHandle: () => this._keyboard.handle,
            getKeyboardActor: () => this._container,
            physicalKeyboard: this._physical,
        });

        this._settings.connectObject(
            'changed::key-height-mm', () => this._relayout(),
            'changed::show-f-row', () => this._afterRebuild(),
            'changed::layout', () => this._afterRebuild(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);

        this._relayout();
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
        this._metrics?.destroy();
        if (this._container)
            this._container.remove_all_transitions();
        this._workArea?.destroy();
        this._keyboard?.disconnectObject(this);
        this._container?.destroy(); // also destroys the keyboard
        this._visibility = this._indicator = this._physical = this._metrics = null;
        this._workArea = this._keyboard = this._container = null;

        this._restoreBuiltinOsk();
        this._settings = null;
    }

    // ---- built-in GNOME OSK suppression -------------------------------------------------

    _suppressBuiltinOsk() {
        const km = Main.keyboard; // KeyboardManager
        if (!km)
            return;
        this._origSyncEnabled = km._syncEnabled;
        // Disable the built-in auto-enable on touch; it would fight with us.
        km._syncEnabled = function () {
            if (this._keyboard) {
                this._keyboard.setCursorLocation?.(null);
                this._keyboard.destroy();
                this._keyboard = null;
            }
        };
        km._syncEnabled();
        if (km._bottomDragAction) {
            this._origDragEnabled = km._bottomDragAction.enabled;
            km._bottomDragAction.enabled = false;
            // KeyboardManager toggles it in visibility-changed; keep it off by re-asserting.
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

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _relayout() {
        if (!this._container)
            return;
        const monitor = this._monitor();
        if (!monitor)
            return;
        const index = Main.layoutManager.primaryIndex;
        const keyPx = this._metrics.keyHeightPx(index, this._settings.get_double('key-height-mm'));
        this._keyboard.setKeyHeight(keyPx);
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
            this._relayout();
            this._visibility?.rebindHandle?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- show / hide --------------------------------------------------------------------

    _toggle() {
        if (this._visible)
            this._hide();
        else
            this._show();
    }

    _show() {
        if (!this._container || this._visible)
            return;
        this._visible = true;
        this._relayout();
        const c = this._container;
        c.remove_all_transitions();
        c.translation_y = c.height;
        c.show();
        this._workArea.setShown(true);
        c.ease({
            translation_y: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._indicator.setActive(true);
    }

    _hide() {
        if (!this._container || !this._visible)
            return;
        this._visible = false;
        this._keyboard.resetModifiers();
        const c = this._container;
        c.remove_all_transitions();
        c.ease({
            translation_y: c.height,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (this._visible || !this._container)
                    return;
                c.hide();
                this._workArea.setShown(false);
            },
        });
        this._indicator.setActive(false);
    }
}
