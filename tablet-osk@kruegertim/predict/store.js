// predict/store.js — persistent user dictionary (learned words) for the
// prediction engine.  Uses only GLib/Gio (no shell imports) so it can be tested
// with plain `gjs -m`.
//
//   const dict = new UserDict();          // ~/.local/share/tablet-osk/userdict.json
//   const engine = new PredictionEngine({loader, userDict: dict, ...});
//   dict.setPrivate(true);                // password / PIN field: nothing is recorded
//   dict.clear();                         // "Gelerntes Wörterbuch löschen"
//   dict.destroy();                       // flushes pending writes, removes timers

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {MemoryUserDict} from './engine.js';

const SAVE_DELAY_S = 3;

export function defaultUserDictPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'tablet-osk', 'userdict.json']);
}

export class UserDict extends MemoryUserDict {
    /** @param {object} [o] @param {string} [o.path] file path (tests) */
    constructor({path = null} = {}) {
        super(null);
        this._path = path ?? defaultUserDictPath();
        this._saveId = 0;
        this._destroyed = false;
        this._readSync();
        this.changed = () => this._scheduleSave();
    }

    get path() {
        return this._path;
    }

    _readSync() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (ok) {
                const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                this._load(data);
            }
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(GLib.FileError, GLib.FileError.NOENT)))
                console.warn(`tablet-osk: could not read user dictionary ${this._path}: ${e.message}`);
        }
    }

    _scheduleSave() {
        if (this._destroyed || this._saveId)
            return;
        this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SAVE_DELAY_S, () => {
            this._saveId = 0;
            this._writeAsync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _contents() {
        return new TextEncoder().encode(JSON.stringify(this.data));
    }

    _ensureDir() {
        GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o700);
    }

    _writeAsync() {
        try {
            this._ensureDir();
            const file = Gio.File.new_for_path(this._path);
            file.replace_contents_bytes_async(new GLib.Bytes(this._contents()), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        console.warn(`tablet-osk: could not save user dictionary: ${e.message}`);
                    }
                });
        } catch (e) {
            console.warn(`tablet-osk: could not save user dictionary: ${e.message}`);
        }
    }

    /** write pending changes synchronously (called by destroy) */
    flush() {
        if (!this._saveId)
            return;
        GLib.source_remove(this._saveId);
        this._saveId = 0;
        try {
            this._ensureDir();
            GLib.file_set_contents_full(this._path, this._contents(),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
        } catch (e) {
            console.warn(`tablet-osk: could not save user dictionary: ${e.message}`);
        }
    }

    /** forget everything and delete the file */
    clear() {
        super.clear();         // triggers changed() -> schedules a save of the empty dict
        try {
            Gio.File.new_for_path(this._path).delete(null);
        } catch (e) {
            // missing file is fine
        }
    }

    destroy() {
        this.flush();
        this._destroyed = true;
        this.changed = null;
    }
}
