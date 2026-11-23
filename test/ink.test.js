import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newId, cloneStroke, strokeBBox, unionBBox, distToSegment, strokeHit, hitStrokes, topHit,
  normRect, rectsIntersect, strokesInRect, translateStrokes, scaleStrokes, resizeFactor,
  pasteOffset, appendPoint, strokeToSvgPath,
} from '../src/ink.js';

const stroke = (id, width, points) => ({ id, color: '#111111', width, points });

test('newId', () => {
  const a = newId();
  const b = newId();
  assert.notEqual(a, b);
  assert.match(a, /^s[0-9a-z]+$/);
  assert.match(b, /^s[0-9a-z]+$/);
});

test('cloneStroke', () => {
  const s = stroke('a', 2, [[1, 2], [3, 4]]);
  const c = cloneStroke(s);
  assert.deepEqual(c, s);
  c.points[0][0] = 99;
  assert.equal(s.points[0][0], 1);
});

test('strokeBBox', () => {
  assert.deepEqual(strokeBBox(stroke('a', 2, [[10, 10]])), { x: 9, y: 9, w: 2, h: 2 });
  assert.deepEqual(strokeBBox(stroke('b', 4, [[0, 0], [10, 20]])), { x: -2, y: -2, w: 14, h: 24 });
});

test('unionBBox', () => {
  assert.equal(unionBBox([]), null);
  assert.deepEqual(
    unionBBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 }]),
    { x: 0, y: -5, w: 15, h: 15 },
  );
});

test('distToSegment', () => {
  assert.equal(distToSegment([5, 5], [0, 0], [10, 0]), 5);
  assert.equal(distToSegment([-3, 4], [0, 0], [10, 0]), 5);
  assert.equal(distToSegment([4, 5], [1, 1], [1, 1]), 5);
});

test('strokeHit', () => {
  const s = stroke('a', 2, [[0, 0], [10, 0]]);
  assert.equal(strokeHit(s, [5, 3], 2), true);
  assert.equal(strokeHit(s, [5, 3.5], 2), false);
});

test('hitStrokes', () => {
  const A = stroke('A', 1, [[-5, 0], [5, 0]]);
  const B = stroke('B', 1, [[100, 100], [110, 100]]);
  const C = stroke('C', 1, [[0, -5], [0, 5]]);
  assert.deepEqual(hitStrokes([A, B, C], [0, 0], 1), [A.id, C.id]);
});

test('topHit', () => {
  const A = stroke('A', 1, [[-5, 0], [5, 0]]);
  const B = stroke('B', 1, [[100, 100], [110, 100]]);
  const C = stroke('C', 1, [[0, -5], [0, 5]]);
  assert.equal(topHit([A, B, C], [0, 0], 1), C.id);
  assert.equal(topHit([A, B, C], [50, 50], 1), null);
});

test('normRect', () => {
  assert.deepEqual(normRect(10, 20, 0, 5), { x: 0, y: 5, w: 10, h: 15 });
});

test('rectsIntersect', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), true);
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }), false);
});

test('strokesInRect', () => {
  const inside = stroke('in', 1, [[2, 2], [5, 5]]);
  const outside = stroke('out', 1, [[50, 50], [60, 60]]);
  assert.deepEqual(strokesInRect([inside, outside], { x: 0, y: 0, w: 10, h: 10 }), ['in']);
});

test('translateStrokes', () => {
  const s = stroke('a', 1, [[1, 2], [3, 4]]);
  const out = translateStrokes([s], 10, -1);
  assert.deepEqual(out[0].points, [[11, 1], [13, 3]]);
  assert.equal(out[0].id, 'a');
  assert.deepEqual(s.points, [[1, 2], [3, 4]]);
});

test('scaleStrokes', () => {
  const s = stroke('a', 1, [[1, 1], [2, 3]]);
  const out = scaleStrokes([s], [0, 0], 2);
  assert.deepEqual(out[0].points, [[2, 2], [4, 6]]);
  assert.equal(out[0].width, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(scaleStrokes([s], [0, 0], 0.1)[0].width, 0.25);
  assert.deepEqual(s, stroke('a', 1, [[1, 1], [2, 3]]));
});

test('resizeFactor', () => {
  assert.equal(resizeFactor([0, 0], 10, 10, [20, 15]), 2);
  assert.equal(resizeFactor([0, 0], 10, 10, [-5, -5]), 0.1);
  assert.equal(resizeFactor([0, 0], 10, 10, [1000, 0]), 20);
});

test('pasteOffset', () => {
  const b = { x: 10, y: 10, w: 20, h: 20 };
  assert.deepEqual(pasteOffset(b, 100, 100, true, 1), { dx: 12, dy: 12 });
  assert.deepEqual(pasteOffset(b, 100, 100, false, 1), { dx: 0, dy: 0 });
  assert.equal(pasteOffset({ x: 90, y: 0, w: 20, h: 5 }, 100, 100, false, 1).dx, -10);
  assert.equal(pasteOffset({ x: 5, y: 5, w: 200, h: 5 }, 100, 100, false, 1).dx, -5);
});

test('appendPoint', () => {
  const pts = [];
  assert.equal(appendPoint(pts, [0, 0], 1), true);
  assert.equal(pts.length, 1);
  assert.equal(appendPoint(pts, [0.5, 0], 1), false);
  assert.equal(pts.length, 1);
  assert.equal(appendPoint(pts, [2, 0], 1), true);
  assert.equal(pts.length, 2);
});

test('strokeToSvgPath', () => {
  const toPdf = (x, y) => [x, 100 - y];
  assert.equal(strokeToSvgPath(stroke('a', 1, [[1, 2], [3.456, 4]]), toPdf), 'M 1 -98 L 3.46 -96');
  assert.equal(strokeToSvgPath(stroke('b', 1, [[0, 100]]), toPdf), 'M 0 0 L 0 0');
});
