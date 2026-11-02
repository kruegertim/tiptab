// predict/touch.js — dynamic (invisible) key hit areas.  Pure ES module.
//
// The visible keyboard never changes; only the decision which key a touch
// means does.  For a touch t we pick the key maximising
//     P(char | prefix) ^ strength  *  N(t | key centre, sigmaX, sigmaY)
// with two hard rules (iOS-like):
//   * a touch in the inner 60 % (each axis) of a visible key always returns that key;
//   * a key is only eligible if its visible rectangle is within ~0.5 key size of the touch.
// Keys whose char has no probability (not a letter in `probs`) are never chosen
// instead of the visible key, and a touch on such a key always returns it.

const INNER = 0.3;  // half-width fraction of the "clear hit" core (60 % of the key)
const CAP = 0.5;    // max distance (in key sizes) from a key's visible rect to be eligible

function rectDist(key, x, y) {
    const dx = Math.max(0, Math.abs(x - key.cx) - key.w / 2);
    const dy = Math.max(0, Math.abs(y - key.cy) - key.h / 2);
    return [dx, dy];
}

function probOf(probs, ch) {
    if (!probs || !ch)
        return undefined;
    const c = ch.toLowerCase();
    return probs instanceof Map ? probs.get(c) : probs[c];
}

/**
 * Detailed variant.  Returns {key, char, visibleKey, changed} or null if there are no keys.
 *   point:   {x, y}
 *   keys:    [{char, cx, cy, w, h, ...}]   centres/sizes in the same coordinate space
 *   probs:   Map(char -> prob) (from engine.nextKeyProbs) or plain object, or null
 *   options: {sigmaX, sigmaY, enabled = true, strength = 1}
 *            sigma defaults: 0.45 * width / height of the visible key
 */
export function resolveTouchDetailed({x, y}, keys, probs, options = {}) {
    if (!keys || keys.length === 0)
        return null;
    const {enabled = true, strength = 1} = options;

    // the visibly hit key: containing rect, else the nearest rect
    let visible = null, bestD = Infinity;
    for (const k of keys) {
        const [dx, dy] = rectDist(k, x, y);
        const d = dx * dx + dy * dy;
        if (d < bestD || (d === bestD && visible &&
            Math.hypot(x - k.cx, y - k.cy) < Math.hypot(x - visible.cx, y - visible.cy))) {
            bestD = d;
            visible = k;
        }
    }
    const result = key => ({key, char: key.char, visibleKey: visible, changed: key !== visible});

    if (!enabled || !probs)
        return result(visible);
    const pv = probOf(probs, visible.char);
    if (pv === undefined)
        return result(visible);          // function / punctuation key: leave it alone
    if (bestD === 0 && Math.abs(x - visible.cx) <= INNER * visible.w &&
        Math.abs(y - visible.cy) <= INNER * visible.h)
        return result(visible);          // clear hit

    const sx = options.sigmaX ?? 0.45 * visible.w;
    const sy = options.sigmaY ?? 0.45 * visible.h;
    let best = visible, bestScore = -Infinity;
    for (const k of keys) {
        const p = probOf(probs, k.char);
        if (p === undefined || p <= 0)
            continue;
        const [dx, dy] = rectDist(k, x, y);
        if (dx > CAP * k.w || dy > CAP * k.h)
            continue;
        const ex = (x - k.cx) / sx, ey = (y - k.cy) / sy;
        const score = strength * Math.log(p) - 0.5 * (ex * ex + ey * ey);
        if (score > bestScore) {
            bestScore = score;
            best = k;
        }
    }
    return result(best);
}

/** Contract API: returns the chosen key's char. */
export function resolveTouch(point, keys, probs, options = {}) {
    const r = resolveTouchDetailed(point, keys, probs, options);
    return r ? r.char : null;
}
