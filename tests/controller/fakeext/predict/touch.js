export function resolveTouch(pt, keys, probs, opts) {
    globalThis.__touchCall = {pt, keys, probs, opts};
    return 's';
}
