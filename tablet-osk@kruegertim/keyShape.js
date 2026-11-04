// Two-part keys (ISO Enter, angled left Shift) drawn as ONE outline.
//
// The two key actors of such a key only do hit-testing and carry the labels;
// they are transparent. The upper part owns a drawing area that paints the
// L-shaped key with the same corner radius on every corner (convex and the
// concave inner corner), the same rim and glow as the other keys, the press
// flash and the active/latched/locked colours.
//
// Pure geometry (no gi imports) so it can be unit tested with node.

// Colours mirror stylesheet.css (.tosk-key-special and its states).
export const SHAPE_COLORS = {
    normal: [0x10, 0x10, 0x10],
    active: [0x3a, 0x3a, 0x3a],
    latched: [0xd1, 0x28, 0x1c],
};

/**
 * Outline of the union of two stacked rectangles that share their left or
 * right edge, joined across the row gap. Coordinates in any common space.
 *
 * @param {{x1:number,x2:number,y1:number,y2:number}} a upper rectangle
 * @param {{x1:number,x2:number,y1:number,y2:number}} b lower rectangle (b.y1 > a.y2)
 * @returns {Array<[number, number]>} clockwise polygon (screen coordinates, y down)
 */
export function lShapePolygon(a, b) {
    const pts = [];
    // top edge of a
    pts.push([a.x1, a.y1], [a.x2, a.y1]);
    // right side
    if (b.x2 > a.x2)
        pts.push([a.x2, b.y1], [b.x2, b.y1]);       // b sticks out right: step out
    else if (b.x2 < a.x2)
        pts.push([a.x2, a.y2], [b.x2, a.y2]);       // a sticks out right: step in
    pts.push([b.x2, b.y2], [b.x1, b.y2]);
    // left side, going up
    if (b.x1 < a.x1)
        pts.push([b.x1, b.y1], [a.x1, b.y1]);       // b sticks out left
    else if (b.x1 > a.x1)
        pts.push([b.x1, a.y2], [a.x1, a.y2]);       // a sticks out left
    return pts;
}

/**
 * Rounded path segments for an axis-aligned polygon: every corner (convex or
 * concave) is rounded with radius r (clamped to half the adjacent edges).
 * Returns ops for a cairo-like context: ['M',x,y] | ['L',x,y] | ['C',x1,y1,x2,y2,x,y].
 */
export function roundedPath(pts, r) {
    const K = 0.5523; // circle approximation by a cubic Bézier
    const n = pts.length;
    const ops = [];
    const corner = i => {
        const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
        const lin = Math.hypot(c[0] - p[0], c[1] - p[1]);
        const lout = Math.hypot(q[0] - c[0], q[1] - c[1]);
        const ri = Math.max(0, Math.min(r, lin / 2, lout / 2));
        const din = [(c[0] - p[0]) / (lin || 1), (c[1] - p[1]) / (lin || 1)];
        const dout = [(q[0] - c[0]) / (lout || 1), (q[1] - c[1]) / (lout || 1)];
        return {
            start: [c[0] - din[0] * ri, c[1] - din[1] * ri],
            c1: [c[0] - din[0] * ri * (1 - K), c[1] - din[1] * ri * (1 - K)],
            c2: [c[0] + dout[0] * ri * (1 - K), c[1] + dout[1] * ri * (1 - K)],
            end: [c[0] + dout[0] * ri, c[1] + dout[1] * ri],
        };
    };
    const cs = pts.map((_, i) => corner(i));
    ops.push(['M', ...cs[0].end]);
    for (let k = 1; k <= n; k++) {
        const c = cs[k % n];
        ops.push(['L', ...c.start]);
        ops.push(['C', ...c.c1, ...c.c2, ...c.end]);
    }
    return ops;
}

function tracePath(cr, ops, dx, dy) {
    cr.newPath();
    for (const op of ops) {
        if (op[0] === 'M')
            cr.moveTo(op[1] + dx, op[2] + dy);
        else if (op[0] === 'L')
            cr.lineTo(op[1] + dx, op[2] + dy);
        else
            cr.curveTo(op[1] + dx, op[2] + dy, op[3] + dx, op[4] + dy, op[5] + dx, op[6] + dy);
    }
    cr.closePath();
}

/**
 * Paint the joined key into a cairo context.
 * geom: {a, b, ox, oy} rectangles in owner-local coordinates and the drawing
 * area's origin (owner-local) so the path is shifted by (-ox, -oy).
 * look: {radius, state: 'normal'|'active'|'latched', locked, flashA,
 *        glow (0..1), borderW, blur, lockBarW}
 */
export function paintJoinedKey(cr, geom, look) {
    const pts = lShapePolygon(geom.a, geom.b);
    const ops = roundedPath(pts, look.radius);
    const dx = -geom.ox, dy = -geom.oy;
    const s = Math.min(1, Math.max(0, look.glow ?? 0));

    // outer glow: soft strokes outside the outline (the fill covers the inner half)
    if (s > 0.001 && look.blur > 0) {
        const glowA = 0.08 + 0.32 * s;
        for (let i = look.blur; i >= 1; i--) {
            tracePath(cr, ops, dx, dy);
            cr.setLineWidth(2 * i);
            cr.setSourceRGBA(1, 1, 1, glowA * (1 - (i - 0.5) / (look.blur + 0.5)) * 0.6);
            cr.stroke();
        }
    }

    // key body
    const [r, g, bl] = SHAPE_COLORS[look.state] ?? SHAPE_COLORS.normal;
    tracePath(cr, ops, dx, dy);
    cr.setSourceRGBA(r / 255, g / 255, bl / 255, 1);
    cr.fillPreserve();
    cr.save();
    cr.clip();

    // press flash
    if (look.flashA > 0.005) {
        cr.setSourceRGBA(1, 1, 1, look.flashA);
        cr.paint();
    }

    // locked: white bar along the bottom edge (like .tosk-locked)
    if (look.locked && look.lockBarW > 0) {
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.rectangle(geom.b.x1 + dx, geom.b.y2 - look.lockBarW + dy,
            geom.b.x2 - geom.b.x1, look.lockBarW);
        cr.fill();
    }

    // rim: clipped stroke = border of borderW inside the outline
    if (s > 0.001 && look.borderW > 0) {
        tracePath(cr, ops, dx, dy);
        cr.setLineWidth(2 * look.borderW);
        cr.setSourceRGBA(1, 1, 1, 0.12 + 0.33 * s);
        cr.stroke();
    }
    cr.restore();
}
