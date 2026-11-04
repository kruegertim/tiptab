// Node ESM loader hooks for testing extension modules outside GNOME Shell:
// gi://X and resource:///… map to stubs in ./stubs, extension .js files are treated as ESM.
import {pathToFileURL, fileURLToPath} from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const stub = n => pathToFileURL(path.join(here, 'stubs', `${n}.mjs`)).href;
export async function resolve(spec, ctx, next) {
    if (spec.startsWith('gi://'))
        return {url: stub(spec.slice(5).split('?')[0]), shortCircuit: true};
    if (spec.startsWith('resource:///'))
        return {url: stub(path.basename(spec, '.js')), shortCircuit: true};
    return next(spec, ctx);
}
export async function load(url, ctx, next) {
    if (url.includes('tablet-osk@kruegertim') && url.endsWith('.js'))
        return {...await next(url, {...ctx, format: 'module'}), format: 'module'};
    return next(url, ctx);
}
