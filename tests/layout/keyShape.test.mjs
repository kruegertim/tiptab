import test from 'node:test';
import assert from 'node:assert/strict';
import {lShapePolygon, roundedPath} from '../../tablet-osk@kruegertim/keyShape.js';

test('angled Shift: stub on top-left, wide lower part', () => {
    const a = {x1: 0, x2: 40, y1: 0, y2: 50}, b = {x1: 0, x2: 80, y1: 55, y2: 105};
    assert.deepEqual(lShapePolygon(a, b),
        [[0, 0], [40, 0], [40, 55], [80, 55], [80, 105], [0, 105]]);
});

test('ISO Enter: wide top, narrower lower part flush right', () => {
    const a = {x1: 0, x2: 80, y1: 0, y2: 50}, b = {x1: 15, x2: 80, y1: 55, y2: 105};
    assert.deepEqual(lShapePolygon(a, b),
        [[0, 0], [80, 0], [80, 105], [15, 105], [15, 50], [0, 50]]);
});

test('rounded path has one corner curve per vertex', () => {
    const pts = [[0, 0], [40, 0], [40, 55], [80, 55], [80, 105], [0, 105]];
    const ops = roundedPath(pts, 6);
    assert.equal(ops.filter(o => o[0] === 'C').length, pts.length);
    assert.equal(ops[0][0], 'M');
});
