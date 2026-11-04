// Minimal GLib stub with a manually driven main loop.
import fs from 'node:fs';
import path from 'node:path';
const DATA_DIR = process.env.TOSK_TEST_DATA_DIR ?? '/nonexistent-tosk-test';
let nextId = 1;
let clock = 0; // µs
const sources = new Map(); // id -> {fn, due, idle}
const GLib = {
    PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 200, PRIORITY_HIGH_IDLE: 100,
    SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    FileTest: {EXISTS: 16},
    idle_add(_p, fn) { const id = nextId++; sources.set(id, {fn, due: clock, idle: true}); return id; },
    timeout_add(_p, ms, fn) { const id = nextId++; sources.set(id, {fn, due: clock + ms * 1000}); return id; },
    source_remove(id) { if (!sources.delete(id)) throw new Error(`source ${id} not found`); },
    get_monotonic_time() { return clock; },
    filename_to_uri(p) { return `file://${p}`; },
    path_is_absolute(p) { return p.startsWith('/'); },
    file_test(p) { return fs.existsSync(p); },
    file_get_contents(p) {
        if (!fs.existsSync(p)) { const e = new GLib.Error('NOENT'); e.matches = () => true; throw e; }
        return [true, new Uint8Array(fs.readFileSync(p))];
    },
    Error: class extends Error {},
    FileError: {NOENT: 4},
    FileSetContentsFlags: {CONSISTENT: 1},
    PRIORITY_LOW: 300,
    Bytes: class { constructor(d) { this.d = d; } },
    get_user_data_dir() { return DATA_DIR; },
    build_filenamev(parts) { return path.join(...parts); },
    path_get_dirname(p) { return path.dirname(p); },
    mkdir_with_parents(p) { fs.mkdirSync(p, {recursive: true}); return 0; },
    file_set_contents_full(p, data) { fs.writeFileSync(p, data); return true; },
    timeout_add_seconds(pr, s, fn) { return GLib.timeout_add(pr, s * 1000, fn); },
    // test helpers
    _advance(ms) { clock += ms * 1000; },
    _pending() { return sources.size; },
    async _run(maxMs = 0) {
        // run due sources repeatedly (and let promises settle) until idle
        const end = clock + maxMs * 1000;
        for (let guard = 0; guard < 10000; guard++) {
            await new Promise(r => setImmediate(r));
            const due = [...sources.entries()].filter(([, s]) => s.due <= clock).sort((a, b) => a[1].due - b[1].due);
            if (!due.length) {
                const later = [...sources.values()].filter(s => s.due <= end).map(s => s.due);
                if (!later.length) {
                    // give pending promises (dynamic import, fs) a chance to schedule sources
                    let woke = false;
                    for (let i = 0; i < 15 && !woke; i++) {
                        await new Promise(r => setTimeout(r, 20));
                        woke = [...sources.values()].some(s2 => s2.due <= end);
                    }
                    if (!woke)
                        return;
                    continue;
                }
                clock = Math.min(...later);
                continue;
            }
            const [id, s] = due[0];
            sources.delete(id);
            if (s.fn() === true)
                sources.set(id, s);
        }
        throw new Error('main loop did not settle');
    },
};
export default GLib;
