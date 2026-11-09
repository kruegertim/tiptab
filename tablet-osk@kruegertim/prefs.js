import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
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
        layoutGroup.add(comboRow(window, settings, 'layout-style', 'Tastenanordnung', [
            ['classic', 'Klassisch (ThinkPad, 5–6 Reihen)'],
            ['touch', 'Touch (4 Reihen, &123-Ebene, Emoji; nach Windows 11)'],
        ]));
        layoutGroup.add(switchRow(settings, 'auto-capitalize', 'Satzanfang groß',
            'Nur Touch: nach . ! ? und Enter beginnt das nächste Wort groß'));
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
        layoutGroup.add(switchRow(settings, 'keep-key-aspect', 'Proportionen beibehalten',
            'Unter 13 mm wird die angedockte Tastatur schmaler, statt die Tasten flacher zu machen'));

        // --- Mode / position ---
        const modeGroup = new Adw.PreferencesGroup({title: 'Modus'});
        page.add(modeGroup);

        modeGroup.add(comboRow(window, settings, 'mode', 'Modus', [
            ['docked', 'Angedockt'],
            ['floating', 'Schwebend'],
            ['thumb', 'Daumen'],
        ], 'Angedockt = volle Breite am unteren Rand; Schwebend = frei verschiebbar und skalierbar; ' +
            'Daumen = geteilte Tastatur links und rechts unten (nur im Querformat)'));

        const thumbHeightRow = new Adw.SpinRow({
            title: 'Tastenhöhe im Daumen-Modus (mm)',
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 7, upper: 20, step_increment: 0.5, page_increment: 1}),
        });
        settings.bind('thumb-key-height-mm', thumbHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        modeGroup.add(thumbHeightRow);

        const shrinkRow = switchRow(settings, 'shrink-workarea', 'Inhalt verkleinern',
            'Fenster machen der Tastatur Platz, statt verdeckt zu werden (nur angedockt)');
        modeGroup.add(shrinkRow);

        const widthRow = new Adw.SpinRow({
            title: 'Breite angedockt (%)',
            subtitle: 'Gesamtbreite der angedockten Tastatur, zentriert (schmalere Tasten)',
            digits: 0,
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, page_increment: 10}),
        });
        const syncWidth = () => {
            const pct = Math.round(settings.get_double('docked-width') * 100);
            if (widthRow.value !== pct)
                widthRow.value = pct;
        };
        syncWidth();
        widthRow.connect('notify::value', () => {
            const v = widthRow.value / 100;
            if (Math.abs(settings.get_double('docked-width') - v) > 0.001)
                settings.set_double('docked-width', v);
        });
        const widthId = settings.connect('changed::docked-width', syncWidth);
        window.connect('close-request', () => {
            settings.disconnect(widthId);
            return false;
        });
        modeGroup.add(widthRow);

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

        const brightnessRow = new Adw.SpinRow({
            title: 'Helligkeit der Beschriftung (%)',
            subtitle: 'Helligkeit der Tastenbeschriftung (100 % = fast weiß)',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 65,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        const syncBrightness = () => {
            const pct = Math.round(settings.get_double('label-brightness') * 100);
            if (brightnessRow.value !== pct)
                brightnessRow.value = pct;
        };
        syncBrightness();
        brightnessRow.connect('notify::value', () => {
            const v = brightnessRow.value / 100;
            if (Math.abs(settings.get_double('label-brightness') - v) > 0.001)
                settings.set_double('label-brightness', v);
        });
        const brightnessId = settings.connect('changed::label-brightness', syncBrightness);
        window.connect('close-request', () => {
            settings.disconnect(brightnessId);
            return false;
        });
        modeGroup.add(brightnessRow);

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
            thumbHeightRow.sensitive = settings.get_string('mode') === 'thumb';
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

        // --- Modifier keys ---
        const modGroup = new Adw.PreferencesGroup({title: 'Sondertasten'});
        page.add(modGroup);

        modGroup.add(comboRow(window, settings, 'super-symbol', 'Symbol der Super-Taste', [
            ['fish', 'Fisch'],
            ['tux', 'Tux'],
            ['diamond', 'Raute'],
            ['text', 'Super'],
        ]));

        const holdSwitchRow = switchRow(settings, 'modifier-hold-release',
            'Gehaltene Umschalttasten beim Loslassen lösen',
            'Gehaltene Umschalt-/Strg-/Alt-/AltGr-/Fn-/Super-Taste wirkt während des Haltens und wird ' +
            'nach der Haltedauer beim Loslassen gelöst');
        modGroup.add(holdSwitchRow);

        const holdRow = new Adw.SpinRow({
            title: 'Haltedauer (s)',
            subtitle: 'So lange gehalten gilt eine Umschalttaste als gehalten statt angetippt',
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: 0.3,
                upper: 2.0,
                step_increment: 0.1,
                page_increment: 0.5,
            }),
        });
        // key is in ms, UI shows seconds (manual two-way sync, see opacity)
        const syncHold = () => {
            const sec = settings.get_int('modifier-hold-ms') / 1000;
            if (Math.abs(holdRow.value - sec) > 0.001)
                holdRow.value = sec;
            holdRow.sensitive = settings.get_boolean('modifier-hold-release');
        };
        syncHold();
        holdRow.connect('notify::value', () => {
            const ms = Math.round(holdRow.value * 10) * 100;
            if (settings.get_int('modifier-hold-ms') !== ms)
                settings.set_int('modifier-hold-ms', ms);
        });
        const holdIds = [
            settings.connect('changed::modifier-hold-ms', syncHold),
            settings.connect('changed::modifier-hold-release', syncHold),
        ];
        window.connect('close-request', () => {
            holdIds.forEach(id => settings.disconnect(id));
            return false;
        });
        modGroup.add(holdRow);

        // --- Prediction ---
        const predictGroup = new Adw.PreferencesGroup({
            title: 'Vorhersage',
            description: 'In Passwort-, PIN-, Zahlen- und Terminalfeldern ist die Vorhersage immer aus ' +
                'und es wird nichts gelernt.',
        });
        page.add(predictGroup);

        predictGroup.add(switchRow(settings, 'suggestions', 'Vorschläge',
            'Drei Wortvorschläge über oder unter den Tasten; nach einem Leerzeichen das wahrscheinlich nächste Wort'));
        predictGroup.add(comboRow(window, settings, 'suggestion-bar-position', 'Position der Vorschlagsleiste', [
            ['top', 'Oben (über den Tasten)'],
            ['bottom', 'Unten (unter den Tasten)'],
        ]));
        predictGroup.add(switchRow(settings, 'autocorrect', 'Autokorrektur',
            'Tippfehler werden bei Leerzeichen oder Satzzeichen korrigiert; Rücktaste direkt danach ' +
            'stellt das getippte Wort wieder her'));
        predictGroup.add(switchRow(settings, 'dynamic-hitareas', 'Dynamische Trefferflächen',
            'Wahrscheinliche nächste Buchstaben sind unsichtbar etwas leichter zu treffen'));
        predictGroup.add(comboRow(window, settings, 'prediction-language', 'Sprache', [
            ['auto', 'Automatisch (nach Layout)'],
            ['de', 'Deutsch'],
            ['en', 'Englisch'],
        ]));

        const clearRow = new Adw.ActionRow({
            title: 'Gelerntes Wörterbuch löschen',
            subtitle: 'Entfernt alle Wörter, die die Tastatur von dir gelernt hat',
        });
        const clearButton = new Gtk.Button({
            label: 'Löschen',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        let clearTimeout = 0;
        const resetClear = () => {
            if (clearTimeout)
                GLib.source_remove(clearTimeout);
            clearTimeout = 0;
            clearButton.label = 'Löschen';
        };
        clearButton.connect('clicked', () => {
            if (!clearTimeout) {
                clearButton.label = 'Wirklich löschen?';
                clearTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    clearTimeout = 0;
                    clearButton.label = 'Löschen';
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            resetClear();
            settings.set_int('clear-userdict-request',
                (settings.get_int('clear-userdict-request') + 1) % 1000000);
            window.add_toast?.(new Adw.Toast({title: 'Gelerntes Wörterbuch gelöscht'}));
        });
        window.connect('close-request', () => {
            resetClear();
            return false;
        });
        clearRow.add_suffix(clearButton);
        predictGroup.add(clearRow);

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
