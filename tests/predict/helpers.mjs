// Shared helpers for the prediction tests (node >= 18, no dependencies).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PREDICT_DIR = path.resolve(here, '../../tablet-osk@kruegertim/predict');
export const DATA_DIR = path.join(PREDICT_DIR, 'data');

const {DataLoader} = await import(path.join(PREDICT_DIR, 'loader.js'));
const engineMod = await import(path.join(PREDICT_DIR, 'engine.js'));
export const {PredictionEngine, MemoryUserDict} = engineMod;
export const engineModule = engineMod;
export const touchModule = await import(path.join(PREDICT_DIR, 'touch.js'));
export const loaderModule = await import(path.join(PREDICT_DIR, 'loader.js'));

export const loader = new DataLoader({readFile: p => fs.readFileSync(p, 'utf8'), dataDir: DATA_DIR});

export function makeEngine(lang, layout = lang === 'en' ? 'qwerty' : 'qwertz', userDict = new MemoryUserDict()) {
    return new PredictionEngine({loader, lang, layout, userDict});
}
