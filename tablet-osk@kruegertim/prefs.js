import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Adw.ComboRow bound to a string/enum key. choices: [[nick, label], ...]
function comboRow(window, settings, key, title, choices, subtitle = null) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    if (subtitle)
        row.subtitle = subtitle;

    const sync = () => {
        const idx = choices.findIndex(([nick]) => nick === settings.get_string(key));
        if (idx >= 0 && row.selected !== idx)
            row.selected = idx;
    };
    sync();
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice && settings.get_string(key) !== choice[0])
            settings.set_string(key, choice[0]);
    });
    const id = settings.connect(`changed::${key}`, sync);
    window.connect('close-request', () => {
        settings.disconnect(id);
        return false;
    });
    return row;
}

export default class TabletOskPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._tabletOskSettings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Tastatur',
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(page);

        // --- Layout ---
        const layoutGroup = new Adw.PreferencesGroup({title: 'Layout'});
        page.add(layoutGroup);

        layoutGroup.add(comboRow(window, settings, 'layout', 'Tastaturlayout', [
            ['qwertz', 'QWERTZ (Deutsch)'],
            ['qwerty', 'QWERTY (US)'],
        ]));
        layoutGroup.add(switchRow(settings, 'show-f-row', 'Mit F-Reihe',
            'Aus = Kompakt: F1–F12 über Fn + Zahlenreihe'));

        const heightRow = new Adw.SpinRow({
            title: 'Tastenhöhe (mm)',
            subtitle: 'Physische Höhe einer Taste. Typisch: 10–12 mm (Laptop-Tastatur ≈ 14 mm, ' +
                'Smartphone ≈ 7–8 mm). Größer = leichter zu treffen, aber weniger Platz.',
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: 7,
                upper: 20,
                step_increment: 0.5,
                page_increment: 1,
            }),
        });
        settings.bind('key-height-mm', heightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(heightRow);

        // --- Mode / position ---
        const modeGroup = new Adw.PreferencesGroup({title: 'Modus'});
        page.add(modeGroup);

        modeGroup.add(comboRow(window, settings, 'mode', 'Modus', [
            ['docked', 'Angedockt'],
            ['floating', 'Schwebend'],
        ], 'Angedockt = volle Breite am unteren Rand; Schwebend = frei verschiebbar und skalierbar'));

        const shrinkRow = switchRow(settings, 'shrink-workarea', 'Inhalt verkleinern',
            'Fenster machen der Tastatur Platz, statt verdeckt zu werden (nur angedockt)');
        modeGroup.add(shrinkRow);

        const opacityRow = new Adw.SpinRow({
            title: 'Deckkraft (%)',
            subtitle: 'Deckkraft der schwebenden Tastatur',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        // Key is 0.3–1.0, UI shows percent. Manual two-way sync because
        // g_settings_bind_with_mapping is not usable from gjs on GLib 2.80.
        const syncOpacity = () => {
            const pct = Math.round(settings.get_double('floating-opacity') * 100);
            if (opacityRow.value !== pct)
                opacityRow.value = pct;
        };
        syncOpacity();
        opacityRow.connect('notify::value', () => {
            const v = opacityRow.value / 100;
            if (Math.abs(settings.get_double('floating-opacity') - v) > 0.001)
                settings.set_double('floating-opacity', v);
        });
        const opacityId = settings.connect('changed::floating-opacity', syncOpacity);
        window.connect('close-request', () => {
            settings.disconnect(opacityId);
            return false;
        });
        modeGroup.add(opacityRow);

        const resetRow = new Adw.ActionRow({
            title: 'Position zurücksetzen',
            subtitle: 'Schwebende Tastatur wieder zentriert am unteren Rand mit Standardbreite',
        });
        const resetButton = new Gtk.Button({
            label: 'Zurücksetzen',
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('floating-x');
            settings.reset('floating-y');
            settings.reset('floating-width');
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        modeGroup.add(resetRow);

        const syncModeSensitivity = () => {
            const floating = settings.get_string('mode') === 'floating';
            opacityRow.sensitive = floating;
            resetRow.sensitive = floating;
            shrinkRow.sensitive = !floating;
        };
        syncModeSensitivity();
        const modeId = settings.connect('changed::mode', syncModeSensitivity);
        window.connect('close-request', () => {
            settings.disconnect(modeId);
            return false;
        });

        // --- Behaviour ---
        const behaviourGroup = new Adw.PreferencesGroup({title: 'Verhalten'});
        page.add(behaviourGroup);

        behaviourGroup.add(switchRow(settings, 'auto-show', 'Automatisch einblenden',
            'Tastatur erscheint, wenn ein Textfeld den Fokus erhält'));
        behaviourGroup.add(switchRow(settings, 'move-dock-left', 'Dock beim Einblenden nach links verschieben',
            'Ein unten angeordnetes Dock wird nach links verschoben, solange die angedockte Tastatur sichtbar ist'));
        behaviourGroup.add(switchRow(settings, 'hide-after-submit', 'Nach dem Absenden ausblenden',
            'Automatisch eingeblendete Tastatur verschwindet nach Enter in einzeiligen Feldern (Formular/Nachricht gesendet) oder Esc'));
        behaviourGroup.add(switchRow(settings, 'show-panel-icon', 'Symbol in der oberen Leiste',
            'Antippen blendet die Tastatur ein/aus'));
        behaviourGroup.add(switchRow(settings, 'swipe-gestures', 'Wischgesten',
            'Vom unteren Rand nach oben wischen zum Einblenden, auf dem Griff nach unten zum Ausblenden'));

        // --- Test ---
        const testGroup = new Adw.PreferencesGroup({
            title: 'Test',
            description: 'Optionen zum Ausprobieren am Laptop',
        });
        page.add(testGroup);

        testGroup.add(switchRow(settings, 'ignore-physical-keyboard',
            'Physische Tastatur ignorieren',
            'Automatisch einblenden, auch wenn eine externe Tastatur angeschlossen ist'));
    }
}
