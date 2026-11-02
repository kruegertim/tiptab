// Temporarily moves the Ubuntu Dock / Dash to Dock from the bottom edge to the left
// while the docked keyboard is visible, so it never covers the space-bar row.
// The original position is remembered in our own GSettings key and restored on hide,
// on disable and on the next enable (crash safety).
import Gio from 'gi://Gio';

const DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';

export class DockMover {
    constructor(settings) {
        this._settings = settings;
        const source = Gio.SettingsSchemaSource.get_default();
        const schema = source?.lookup(DOCK_SCHEMA, true);
        this._dock = schema && schema.has_key('dock-position')
            ? new Gio.Settings({settings_schema: schema}) : null;
        this.restore(); // left over from a crash or a session that ended while shown
    }

    // Called right before the docked keyboard slides in.
    moveAway() {
        if (!this._dock || !this._settings.get_boolean('move-dock-left'))
            return;
        if (this._settings.get_string('dock-saved-position') !== '')
            return; // already moved
        const pos = this._dock.get_string('dock-position');
        if (pos !== 'BOTTOM')
            return;
        this._settings.set_string('dock-saved-position', pos);
        this._dock.set_string('dock-position', 'LEFT');
    }

    // Called after the keyboard is hidden, when switching to floating mode, and on disable.
    restore() {
        if (!this._dock)
            return;
        const saved = this._settings.get_string('dock-saved-position');
        if (saved === '')
            return;
        this._settings.set_string('dock-saved-position', '');
        // Only put it back if nobody changed it in the meantime.
        if (this._dock.get_string('dock-position') === 'LEFT')
            this._dock.set_string('dock-position', saved);
    }

    destroy() {
        this.restore();
        this._dock = null;
        this._settings = null;
    }
}
