// SPDX-License-Identifier: GPL-2.0-or-later
// Top-bar toggle icon for tablet-osk.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const DEFAULT_ROLE = 'tablet-osk@kruegertim';

export const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    // new PanelIndicator({onToggle, settings, uuid?})
    _init({onToggle, settings, uuid} = {}) {
        super._init(0.0, 'Tablet OSK', true /* dontCreateMenu */);

        this._onToggle = onToggle;
        this._settings = settings;
        this._active = false;

        this.add_style_class_name('tablet-osk-indicator');
        this._icon = new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._toggle();
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._toggle();
            return Clutter.EVENT_STOP;
        });
        // Keyboard activation (focus navigation in the panel)
        this.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_space || sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._settings?.connectObject('changed::show-panel-icon',
            () => this._syncVisible(), this);
        Main.panel.addToStatusArea(uuid ?? DEFAULT_ROLE, this);
        // after addToStatusArea, which calls container.show()
        this._syncVisible();
    }

    _toggle() {
        try {
            this._onToggle?.();
        } catch (e) {
            console.error(`[tablet-osk] toggle failed: ${e}`);
        }
    }

    _syncVisible() {
        const visible = this._settings ? this._settings.get_boolean('show-panel-icon') : true;
        this.visible = visible;
        if (this.container)
            this.container.visible = visible;
    }

    setActive(visible) {
        this._active = !!visible;
        if (this._active) {
            this.add_style_pseudo_class('active');
            this.add_style_pseudo_class('checked');
        } else {
            this.remove_style_pseudo_class('active');
            this.remove_style_pseudo_class('checked');
        }
    }

    destroy() {
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._onToggle = null;
        // Main.panel removes the statusArea entry on 'destroy'.
        super.destroy();
    }
});
