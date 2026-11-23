// Pure stroke-geometry helpers. Coordinates are PDF points, origin top-left, y down.

let counter = 0;

/** Returns a new unique stroke id. */
export function newId() {
  return 's' + (++counter).toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Returns a copy of a stroke with its points deep-copied. */
export function cloneStroke(s) {
  return { id: s.id, color: s.color, width: s.width, points: s.points.map(p => [p[0], p[1]]) };
}

/** Returns the stroke's bounding rect, expanded by half its width on every side. */
export function strokeBBox(s) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of s.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const r = s.width / 2;
  return { x: minX - r, y: minY - r, w: maxX - minX + 2 * r, h: maxY - minY + 2 * r };
}

/** Returns the union rect of an array of rects, or null for an empty array. */
export function unionBBox(boxes) {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Returns the Euclidean distance from point p to segment a-b. */
export function distToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/** Returns true if p lies within half the stroke width plus r of the stroke. */
export function strokeHit(s, p, r) {
  const pts = s.points;
  let d = pts.length === 1 ? distToSegment(p, pts[0], pts[0]) : Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i - 1], pts[i]));
  return d <= s.width / 2 + r;
}

/** Returns the ids of every stroke hit at p, in input order. */
export function hitStrokes(strokes, p, r) {
  return strokes.filter(s => strokeHit(s, p, r)).map(s => s.id);
}

/** Returns the id of the last (topmost) stroke hit at p, or null. */
export function topHit(strokes, p, r) {
  for (let i = strokes.length - 1; i >= 0; i--) if (strokeHit(strokes[i], p, r)) return strokes[i].id;
  return null;
}

/** Returns the normalized rect spanning two corner points. */
export function normRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Returns true if two rects overlap or touch. */
export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Returns the ids (input order) of strokes whose bbox intersects rect. */
export function strokesInRect(strokes, rect) {
  return strokes.filter(s => rectsIntersect(strokeBBox(s), rect)).map(s => s.id);
}

/** Returns new strokes with every point shifted by dx, dy. */
export function translateStrokes(strokes, dx, dy) {
  return strokes.map(s => ({ id: s.id, color: s.color, width: s.width, points: s.points.map(p => [p[0] + dx, p[1] + dy]) }));
}

/** Returns new strokes scaled by s about anchor, with widths scaled (min 0.25). */
export function scaleStrokes(strokes, anchor, s) {
  return strokes.map(st => ({
    id: st.id,
    color: st.color,
    width: Math.max(0.25, st.width * s),
    points: st.points.map(p => [anchor[0] + (p[0] - anchor[0]) * s, anchor[1] + (p[1] - anchor[1]) * s]),
  }));
}

/** Returns the scale factor for dragging a resize handle to p, clamped to [min, max]. */
export function resizeFactor(anchor, w, h, p, min = 0.1, max = 20) {
  const s = Math.max((p[0] - anchor[0]) / Math.max(w, 1), (p[1] - anchor[1]) / Math.max(h, 1));
  return Math.min(max, Math.max(min, s));
}

/** Returns the paste offset {dx, dy} that cascades on the same page and keeps bbox on the page. */
export function pasteOffset(bbox, pageW, pageH, samePage, n) {
  let dx = samePage ? 12 * n : 0;
  let dy = dx;
  if (bbox.x + dx + bbox.w > pageW) dx = pageW - bbox.w - bbox.x;
  if (bbox.x + dx < 0) dx = -bbox.x;
  if (bbox.y + dy + bbox.h > pageH) dy = pageH - bbox.h - bbox.y;
  if (bbox.y + dy < 0) dy = -bbox.y;
  return { dx, dy };
}

/** Pushes a copy of p onto points (mutates) if it is at least minDist from the last point; returns whether it did. */
export function appendPoint(points, p, minDist) {
  if (points.length === 0) {
    points.push([p[0], p[1]]);
    return true;
  }
  const last = points[points.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) {
    points.push([p[0], p[1]]);
    return true;
  }
  return false;
}

/** Returns an SVG path string for pdf-lib's drawSvgPath, mapping points through toPdf and negating y. */
export function strokeToSvgPath(stroke, toPdf) {
  const fmt = v => {
    const r = Math.round(v * 100) / 100;
    return String(Object.is(r, -0) ? 0 : r);
  };
  const parts = stroke.points.map(([x, y]) => {
    const [px, py] = toPdf(x, y);
    return fmt(px) + ' ' + fmt(-py);
  });
  let d = 'M ' + parts[0];
  if (parts.length === 1) d += ' L ' + parts[0];
  for (let i = 1; i < parts.length; i++) d += ' L ' + parts[i];
  return d;
}
