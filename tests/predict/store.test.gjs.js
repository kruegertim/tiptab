// gjs -m tests/predict/store.test.gjs.js   (store.js needs GLib/Gio, so it is tested with gjs)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const predict = GLib.canonicalize_filename(`${here}/../../tablet-osk@kruegertim/predict`, null);
const {UserDict, defaultUserDictPath} = await import(`file://${predict}/store.js`);
const {PredictionEngine} = await import(`file://${predict}/engine.js`);
const {DataLoader} = await import(`file://${predict}/loader.js`);

let failures = 0, passes = 0;
function check(cond, msg) {
    if (cond) {
        passes++;
        print(`ok - ${msg}`);
    } else {
        failures++;
        print(`not ok - ${msg}`);
    }
}
const readJSON = p => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(p)[1]));

const dir = GLib.dir_make_tmp('osk-userdict-XXXXXX');
const path = `${dir}/sub/userdict.json`;

check(defaultUserDictPath().endsWith('/tablet-osk/userdict.json'), 'default path in user data dir');

// learning + synchronous flush on destroy
let d = new UserDict({path});
const loader = new DataLoader({readFile: p => GLib.file_get_contents(p)[1], dataDir: `${predict}/data`});
let eng = new PredictionEngine({loader, lang: 'de', userDict: d});
eng.learn('Zorkbar');
check(!GLib.file_test(path, GLib.FileTest.EXISTS), 'write is debounced (no file yet)');
eng.learn('Zorkbar');
d.destroy();
check(GLib.file_test(path, GLib.FileTest.EXISTS), 'destroy() flushes');
check(readJSON(path).langs.de.zorkbar.n === 2, 'count persisted');
const mode = Gio.File.new_for_path(path).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode');
check((mode & 0o077) === 0, `file is private (mode ${(mode & 0o777).toString(8)})`);

// reload
d = new UserDict({path});
check(d.isLearned('de', 'zorkbar'), 'reloaded learned word');
eng = new PredictionEngine({loader, lang: 'de', userDict: d});
check(eng.suggest('Zorkb').some(s => s?.word === 'Zorkbar'), 'learned word suggested after reload');

// private mode never stores
d.setPrivate(true);
eng.learn('Geheimnisvollerwort');
eng.learn('Geheimnisvollerwort');
eng.undoAutocorrect('Passwrt', 'Passwort');
d.setPrivate(false);
check(d.get('de', 'geheimnisvollerwort') === null && !d.isBlocked('de', 'passwrt'), 'private mode records nothing');

// debounced async write through the main loop
eng.learn('Quxwort');
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
check(readJSON(path).langs.de.quxwort?.n === 1, 'debounced async save happened');

// clear
d.clear();
check(!GLib.file_test(path, GLib.FileTest.EXISTS), 'clear() removes the file');
check(d.get('de', 'zorkbar') === null, 'clear() empties memory');
d.destroy();
check(readJSON(path).langs && Object.keys(readJSON(path).langs).length === 0, 'empty dict written after clear');

// corrupt file is tolerated
GLib.file_set_contents(path, '{not json');
d = new UserDict({path});
check(d.get('de', 'x') === null, 'corrupt file ignored');
d.destroy();

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(dir)}`);
print(`# pass ${passes}\n# fail ${failures}`);
System.exit(failures ? 1 : 0);
