import fs from 'node:fs';
export default {
    FileCreateFlags: {PRIVATE: 1, REPLACE_DESTINATION: 2},
    File: {new_for_path: p => ({
        delete() { if (!fs.existsSync(p)) throw new Error('missing'); fs.unlinkSync(p); return true; },
        replace_contents_bytes_async(b, _e, _m, _f, _c, cb) { fs.writeFileSync(p, b.d); cb?.(this, null); },
        replace_contents_finish() { return true; },
    })},
};
