import {
  newId, cloneStroke, strokeBBox, unionBBox, hitStrokes, topHit, normRect, strokesInRect,
  translateStrokes, scaleStrokes, resizeFactor, pasteOffset, appendPoint,
} from './ink.js';
import { exportPdf } from './export.js';

const pdfjsLib = globalThis.pdfjsLib;
const SIZES = [1, 2, 4, 8];
const UNDO_CAP = 100;
const THEMES = ['graphite', 'phosphor', 'cobalt', 'paper'];
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const state = {
  name: null,
  bytes: null, // original Uint8Array, never handed to pdf.js
  pdf: null,
  pages: [], // { index, page, viewport (scale 1), w, h (pt), scale, dpr, wrap, el, pdfCanvas, inkCanvas, strokes }
  tool: 'pen',
  size: 2,
  color: '#111111',
  inkVisible: true,
  zoom: null, // null = fit to viewer width
  selection: null, // { page, ids: Set }
  clipboard: null, // { strokes, page, n }
  undo: [],
  redo: [],
  dirty: false,
  active: 0,
  drag: null,
};

const $ = id => document.getElementById(id);
const body = document.body;
const viewer = $('viewer');
const pagesEl = $('pages');
const fileInput = $('file-input');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
const totalStrokes = () => state.pages.reduce((n, p) => n + p.strokes.length, 0);

function setStatus(msg) {
  $('status-msg').textContent = msg;
}

// ---------- worker ----------

function setupWorker() {
  const text = $('pdfjs-worker-src').textContent;
  try {
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
  } catch {
    const s = document.createElement('script');
    s.textContent = text;
    document.head.appendChild(s);
  }
}

// ---------- open / load ----------

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function openFile(file) {
  if (!file) return;
  if (!isPdf(file)) {
    setStatus(`not a pdf: ${file.name}`);
    return;
  }
  if (state.dirty && totalStrokes() > 0 && !confirm('Discard unsaved ink on the current file?')) return;
  setStatus(`loading ${file.name}`);
  let bytes, pdf;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    setStatus(`could not open this file: ${err.message}`);
    return;
  }
  const pages = [];
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ index: i, page, viewport, w: viewport.width, h: viewport.height, scale: 1, dpr: 1, strokes: [] });
    }
  } catch (err) {
    pdf.destroy();
    setStatus(`could not open this file: ${err.message}`);
    return;
  }

  if (state.pdf) state.pdf.destroy();
  Object.assign(state, {
    name: file.name, bytes, pdf, pages,
    selection: null, clipboard: null, undo: [], redo: [], dirty: false, active: 0, drag: null,
  });
  $('file-name').textContent = `~/${file.name}`;
  $('file-name').title = file.name;
  document.title = `quik-sign — ${file.name}`;
  body.classList.add('has-doc');
  buildPages();
  await layout();
  setStatus(`opened ${file.name} · ${plural(pages.length, 'page')}`);
}

function buildPages() {
  pagesEl.textContent = '';
  const grid = $('page-grid');
  grid.textContent = '';
  const n = state.pages.length;
  for (const p of state.pages) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.index = String(p.index);
    const label = document.createElement('div');
    label.className = 'page-label';
    const el = document.createElement('div');
    el.className = 'page';
    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.className = 'pdf';
    const inkCanvas = document.createElement('canvas');
    inkCanvas.className = 'ink';
    el.append(pdfCanvas, inkCanvas);
    wrap.append(label, el);
    pagesEl.appendChild(wrap);
    const cell = document.createElement('button');
    cell.className = 'page-cell';
    cell.dataset.index = String(p.index);
    cell.setAttribute('aria-label', `Go to page ${p.index + 1}`);
    cell.textContent = String(p.index + 1);
    cell.addEventListener('click', () => goToPage(p.index));
    grid.appendChild(cell);
    Object.assign(p, { wrap, el, label, cell, pdfCanvas, inkCanvas });
    wireInk(p);
    applyCursor(p);
  }
}

// While a navigator jump is scrolling, scroll-driven active-page tracking holds off.
let navLockUntil = 0;

function goToPage(i) {
  const p = state.pages[i];
  if (!p) return;
  const top = viewer.scrollTop + p.wrap.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 16;
  navLockUntil = performance.now() + 1000;
  viewer.scrollTo({ top, behavior: 'smooth' });
  setActive(i);
}

// ---------- layout / render ----------

let layoutGen = 0;
let renderTask = null;

async function layout() {
  if (!state.pages.length) return;
  const gen = ++layoutGen;
  if (renderTask) renderTask.cancel();
  const maxW = Math.max(...state.pages.map(p => p.viewport.width));
  const fitScale = Math.min(1.6, Math.max(0.5, (viewer.clientWidth - 48) / maxW));
  const scale = state.zoom ?? fitScale;
  const dpr = window.devicePixelRatio || 1;
  for (const p of state.pages) {
    const cssW = Math.round(p.viewport.width * scale);
    const cssH = Math.round(p.viewport.height * scale);
    p.scale = scale;
    p.dpr = dpr;
    p.el.style.width = `${cssW}px`;
    p.el.style.height = `${cssH}px`;
    for (const c of [p.pdfCanvas, p.inkCanvas]) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    drawInk(p);
  }
  updateActive();
  for (const p of state.pages) {
    if (gen !== layoutGen) return;
    const task = p.page.render({
      canvasContext: p.pdfCanvas.getContext('2d'),
      viewport: p.page.getViewport({ scale: scale * dpr }),
    });
    renderTask = task;
    try {
      await task.promise;
    } catch {
      if (gen !== layoutGen) return;
    }
  }
  if (gen === layoutGen) renderTask = null;
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.zoom === null) layout();
  }, 200);
});

// ---------- zoom ----------

function relayoutKeepingScroll() {
  const r = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  layout(); // sizes every page synchronously before its first await
  viewer.scrollTop = r * viewer.scrollHeight;
  const pct = Math.round(state.pages[0].scale * 100);
  setStatus(state.zoom === null ? 'zoom fit' : `zoom ${pct}%`);
  updateUi();
}

function zoomIn() {
  if (!state.pdf) return;
  const cur = state.pages[0].scale;
  state.zoom = ZOOMS.find(z => z > cur + 0.001) ?? 3;
  relayoutKeepingScroll();
}

function zoomOut() {
  if (!state.pdf) return;
  const cur = state.pages[0].scale;
  state.zoom = [...ZOOMS].reverse().find(z => z < cur - 0.001) ?? 0.5;
  relayoutKeepingScroll();
}

function zoomFit() {
  if (!state.pdf) return;
  state.zoom = null;
  relayoutKeepingScroll();
}

// ---------- ink drawing ----------

function selectedStrokes(p) {
  const ids = state.selection?.page === p.index ? state.selection.ids : new Set();
  return p.strokes.filter(s => ids.has(s.id));
}

function selectionRects(p) {
  const bb = unionBBox(selectedStrokes(p).map(strokeBBox));
  if (!bb) return null;
  const pad = 4 / p.scale;
  return { bb, ex: { x: bb.x - pad, y: bb.y - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad } };
}

function drawInk(p) {
  const ctx = p.inkCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, p.inkCanvas.width, p.inkCanvas.height);
  ctx.setTransform(p.dpr * p.scale, 0, 0, p.dpr * p.scale, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of p.strokes) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    if (s.points.length === 1) ctx.lineTo(s.points[0][0], s.points[0][1]);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i][0], s.points[i][1]);
    ctx.stroke();
  }
  const sel = selectionRects(p);
  if (sel) {
    const { ex } = sel;
    const color = accent();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 / p.scale;
    ctx.setLineDash([4 / p.scale, 3 / p.scale]);
    ctx.strokeRect(ex.x, ex.y, ex.w, ex.h);
    ctx.setLineDash([]);
    const hs = 8 / p.scale;
    ctx.fillStyle = color;
    ctx.fillRect(ex.x + ex.w - hs / 2, ex.y + ex.h - hs / 2, hs, hs);
  }
}

function drawMarquee(p, rect) {
  const ctx = p.inkCanvas.getContext('2d');
  const color = accent();
  ctx.save();
  ctx.lineWidth = 1 / p.scale;
  ctx.setLineDash([3 / p.scale, 3 / p.scale]);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function redrawAll() {
  for (const p of state.pages) drawInk(p);
}

function eraseCursor() {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><circle cx='8' cy='8' r='6' fill='none' stroke='${accent()}' stroke-width='1.5'/></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 8 8, crosshair`;
}

function applyCursor(p) {
  p.inkCanvas.style.cursor = state.tool === 'erase' ? eraseCursor() : '';
}

// ---------- undo ----------

function snapshot() {
  return state.pages.map(p => p.strokes.map(cloneStroke));
}

function restore(snap) {
  state.pages.forEach((p, i) => { p.strokes = snap[i]; });
}

function pushUndoSnap(snap) {
  state.undo.push(snap);
  if (state.undo.length > UNDO_CAP) state.undo.shift();
  state.redo = [];
  state.dirty = true;
}

function pushUndo() {
  pushUndoSnap(snapshot());
}

function undo() {
  if (!state.undo.length) return setStatus('nothing to undo');
  state.redo.push(snapshot());
  restore(state.undo.pop());
  state.selection = null;
  state.dirty = true;
  redrawAll();
  setStatus('undo');
  updateUi();
}

function redo() {
  if (!state.redo.length) return setStatus('nothing to redo');
  state.undo.push(snapshot());
  restore(state.redo.pop());
  state.selection = null;
  state.dirty = true;
  redrawAll();
  setStatus('redo');
  updateUi();
}

// ---------- selection ----------

function clearSelection() {
  const sel = state.selection;
  if (!sel) return;
  state.selection = null;
  const p = state.pages[sel.page];
  if (p) drawInk(p);
}

function replaceStrokes(p, next) {
  const byId = new Map(next.map(s => [s.id, s]));
  p.strokes = p.strokes.map(s => byId.get(s.id) || s);
}

function removeSelected() {
  const sel = state.selection;
  const p = state.pages[sel.page];
  p.strokes = p.strokes.filter(s => !sel.ids.has(s.id));
  state.selection = null;
  drawInk(p);
}

// ---------- pointer input ----------

function toPage(p, e) {
  const rect = p.inkCanvas.getBoundingClientRect();
  return [(e.clientX - rect.left) / p.scale, (e.clientY - rect.top) / p.scale];
}

function coalesced(e) {
  return e.getCoalescedEvents?.() ?? [e];
}

function eraseAt(p, pt) {
  const ids = hitStrokes(p.strokes, pt, 6 / p.scale);
  if (!ids.length) return;
  const gone = new Set(ids);
  p.strokes = p.strokes.filter(s => !gone.has(s.id));
  state.drag.removed += ids.length;
  drawInk(p);
}

function selectHitArea(p, pt) {
  if (state.selection?.page !== p.index) return null;
  const sel = selectionRects(p);
  if (!sel) return null;
  const { ex } = sel;
  const hs = 8 / p.scale;
  if (Math.abs(pt[0] - (ex.x + ex.w)) <= hs && Math.abs(pt[1] - (ex.y + ex.h)) <= hs) return { area: 'handle', ...sel };
  if (pt[0] >= ex.x && pt[0] <= ex.x + ex.w && pt[1] >= ex.y && pt[1] <= ex.y + ex.h) return { area: 'inside', ...sel };
  return null;
}

function onDown(p, e) {
  if (e.button !== 0 || state.drag) return;
  p.inkCanvas.setPointerCapture(e.pointerId);
  setActive(p.index);
  const pt = toPage(p, e);

  if (state.tool === 'pen') {
    pushUndo();
    const stroke = { id: newId(), color: state.color, width: state.size, points: [pt] };
    p.strokes.push(stroke);
    state.drag = { type: 'pen', p, stroke };
    drawInk(p);
  } else if (state.tool === 'erase') {
    state.drag = { type: 'erase', p, before: snapshot(), removed: 0 };
    eraseAt(p, pt);
  } else {
    const hit = selectHitArea(p, pt);
    if (hit?.area === 'handle') {
      pushUndo();
      state.drag = { type: 'resize', p, anchor: [hit.bb.x, hit.bb.y], w: hit.bb.w, h: hit.bb.h, orig: selectedStrokes(p).map(cloneStroke) };
    } else if (hit?.area === 'inside') {
      pushUndo();
      state.drag = { type: 'move', p, start: pt, orig: selectedStrokes(p).map(cloneStroke) };
    } else {
      clearSelection();
      state.drag = { type: 'marquee', p, start: pt, rect: null };
    }
  }
  updateUi();
}

function onMove(p, e) {
  const d = state.drag;
  if (!d) {
    if (state.tool === 'select') {
      const hit = selectHitArea(p, toPage(p, e));
      p.inkCanvas.style.cursor = hit?.area === 'handle' ? 'nwse-resize' : hit ? 'move' : '';
    }
    return;
  }
  if (d.p !== p) return;
  if (d.type === 'pen') {
    for (const ev of coalesced(e)) appendPoint(d.stroke.points, toPage(p, ev), 0.75 / p.scale);
    drawInk(p);
  } else if (d.type === 'erase') {
    for (const ev of coalesced(e)) eraseAt(p, toPage(p, ev));
  } else {
    const pt = toPage(p, e);
    if (d.type === 'resize') {
      replaceStrokes(p, scaleStrokes(d.orig, d.anchor, resizeFactor(d.anchor, d.w, d.h, pt)));
      drawInk(p);
    } else if (d.type === 'move') {
      replaceStrokes(p, translateStrokes(d.orig, pt[0] - d.start[0], pt[1] - d.start[1]));
      drawInk(p);
    } else if (d.type === 'marquee') {
      d.rect = normRect(d.start[0], d.start[1], pt[0], pt[1]);
      drawInk(p);
      drawMarquee(p, d.rect);
    }
  }
}

function onUp(p) {
  const d = state.drag;
  if (!d || d.p !== p) return;
  state.drag = null;
  if (d.type === 'erase') {
    if (d.removed > 0) {
      pushUndoSnap(d.before);
      setStatus(`erased ${plural(d.removed, 'stroke')}`);
    }
  } else if (d.type === 'marquee') {
    const tiny = 3 / p.scale;
    let ids;
    if (!d.rect || (d.rect.w < tiny && d.rect.h < tiny)) {
      const id = topHit(p.strokes, d.start, 6 / p.scale);
      ids = id ? [id] : [];
    } else {
      ids = strokesInRect(p.strokes, d.rect);
    }
    if (ids.length) state.selection = { page: p.index, ids: new Set(ids) };
    drawInk(p);
  }
  updateUi();
}

function wireInk(p) {
  const c = p.inkCanvas;
  c.addEventListener('pointerdown', e => onDown(p, e));
  c.addEventListener('pointermove', e => onMove(p, e));
  c.addEventListener('pointerup', () => onUp(p));
  c.addEventListener('pointercancel', () => onUp(p));
}

// ---------- tools ----------

function setTool(tool) {
  state.tool = tool;
  body.dataset.tool = tool;
  for (const b of document.querySelectorAll('[data-tool]')) {
    if (b !== body) b.classList.toggle('is-active', b.dataset.tool === tool);
  }
  if (tool !== 'select') clearSelection();
  for (const p of state.pages) applyCursor(p);
  updateUi();
}

function setSize(size) {
  state.size = size;
  for (const b of document.querySelectorAll('[data-size]')) b.classList.toggle('is-active', Number(b.dataset.size) === size);
  updateUi();
}

function stepSize(dir) {
  const i = SIZES.indexOf(state.size);
  setSize(SIZES[Math.min(SIZES.length - 1, Math.max(0, i + dir))]);
}

function setColor(color) {
  state.color = color;
  for (const b of document.querySelectorAll('[data-color]')) b.classList.toggle('is-active', b.dataset.color === color);
}

// ---------- clipboard ----------

function copy() {
  const sel = state.selection;
  if (!sel) return 0;
  const strokes = selectedStrokes(state.pages[sel.page]).map(cloneStroke);
  state.clipboard = { strokes, page: sel.page, n: 0 };
  setStatus(`copied ${plural(strokes.length, 'stroke')}`);
  updateUi();
  return strokes.length;
}

function cut() {
  if (!state.selection) return;
  const k = copy();
  pushUndo();
  removeSelected();
  setStatus(`cut ${plural(k, 'stroke')}`);
  updateUi();
}

function del() {
  const sel = state.selection;
  if (!sel) return;
  const k = sel.ids.size;
  pushUndo();
  removeSelected();
  setStatus(`deleted ${plural(k, 'stroke')}`);
  updateUi();
}

function paste() {
  const clip = state.clipboard;
  if (!clip || !state.pages.length) return;
  const target = state.active;
  const page = state.pages[target];
  const same = target === clip.page;
  if (same) clip.n += 1;
  else { clip.page = target; clip.n = 0; }
  const bb = unionBBox(clip.strokes.map(strokeBBox));
  const { dx, dy } = pasteOffset(bb, page.viewport.width, page.viewport.height, same, clip.n);
  pushUndo();
  const added = translateStrokes(clip.strokes, dx, dy).map(s => ({ ...s, id: newId() }));
  page.strokes.push(...added);
  clearSelection();
  state.selection = { page: target, ids: new Set(added.map(s => s.id)) };
  setTool('select');
  drawInk(page);
  setStatus(`pasted ${plural(added.length, 'stroke')} to page ${target + 1}`);
  updateUi();
}

// ---------- active page ----------

function setActive(i) {
  state.active = i;
  for (const p of state.pages) p.wrap.classList.toggle('is-active', p.index === i);
  updateUi();
}

function updateActive() {
  if (!state.pages.length) return;
  const vr = viewer.getBoundingClientRect();
  let best = state.active, bestH = -1;
  for (const p of state.pages) {
    const r = p.wrap.getBoundingClientRect();
    const h = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
    if (h > bestH) { bestH = h; best = p.index; }
  }
  setActive(best);
}

let scrollQueued = false;
viewer.addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (performance.now() < navLockUntil) return;
    updateActive();
  });
});

// ---------- ink layer ----------

function toggleLayer() {
  state.inkVisible = !state.inkVisible;
  body.classList.toggle('ink-hidden', !state.inkVisible);
  if (!state.inkVisible) clearSelection();
  $('layer-text').textContent = state.inkVisible ? 'ink layer on' : 'ink layer off';
  setStatus(state.inkVisible ? 'ink layer shown' : 'ink layer hidden');
  updateUi();
}

// ---------- theme ----------

let themeIndex = 0;

function nextTheme() {
  themeIndex = (themeIndex + 1) % THEMES.length;
  const name = THEMES[themeIndex];
  if (name === 'graphite') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
  $('theme-text').textContent = `theme ${name}`;
  for (const p of state.pages) {
    applyCursor(p);
    drawInk(p);
  }
  setStatus(`theme ${name}`);
}

// ---------- save ----------

const exportCurrent = () => exportPdf(state.bytes, state.pages.map(p => ({ viewport: p.viewport, strokes: p.strokes })));

async function save() {
  if (!state.pdf) return;
  setStatus('saving');
  try {
    const out = await exportCurrent();
    const filename = state.name.replace(/\.pdf$/i, '') + '-signed.pdf';
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    state.dirty = false;
    const inked = state.pages.filter(p => p.strokes.length).map(p => p.index + 1);
    setStatus(`saved ${filename} · ${inked.length ? `ink on pages ${inked.join(', ')}` : 'no ink'}`);
  } catch (err) {
    setStatus(`save failed: ${err.message}`);
  }
}

// ---------- ui ----------

function updateUi() {
  const hasDoc = !!state.pdf;
  const off = (el, v) => { el.disabled = v; };
  off($('btn-save'), !hasDoc);
  off($('btn-layer'), !hasDoc);
  for (const b of document.querySelectorAll('button[data-tool], button[data-size], button[data-color]')) off(b, !hasDoc);
  for (const id of ['btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit']) off($(id), !hasDoc);
  off($('btn-undo'), !hasDoc || !state.undo.length);
  off($('btn-redo'), !hasDoc || !state.redo.length);
  for (const id of ['btn-copy', 'btn-cut', 'btn-delete']) off($(id), !state.selection);
  off($('btn-paste'), !hasDoc || !state.clipboard);
  $('info-page').textContent = hasDoc ? `page ${state.active + 1} / ${state.pages.length}` : 'no file';
  $('info-strokes').textContent = hasDoc ? plural(totalStrokes(), 'stroke') : '';
  const pct = hasDoc ? Math.round(state.pages[0].scale * 100) : 0;
  $('zoom-text').textContent = !hasDoc ? 'fit' : state.zoom === null ? `fit ${pct}%` : `${pct}%`;
  updatePageNav(hasDoc);
}

function updatePageNav(hasDoc) {
  $('pages-section').hidden = !hasDoc;
  if (!hasDoc) return;
  const n = state.pages.length;
  let inked = 0;
  for (const p of state.pages) {
    const k = p.strokes.length;
    if (k) inked++;
    const label = `page ${p.index + 1} / ${n}${k ? ` · ${plural(k, 'stroke')}` : ''}`;
    if (p.label.textContent !== label) p.label.textContent = label;
    p.cell.classList.toggle('is-current', p.index === state.active);
    p.cell.classList.toggle('has-ink', k > 0);
  }
  $('pages-summary').textContent = inked ? `${inked} inked` : '';
  // Keep the current cell visible inside the grid only, without scrolling the sidebar or viewer.
  const grid = $('page-grid');
  const cell = state.pages[state.active]?.cell;
  if (!cell) return;
  const g = grid.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  if (c.top < g.top) grid.scrollTop -= g.top - c.top;
  else if (c.bottom > g.bottom) grid.scrollTop += c.bottom - g.bottom;
}

// ---------- wiring ----------

function pickFile() {
  fileInput.click();
}

function wire() {
  $('btn-open').addEventListener('click', pickFile);
  $('btn-open-empty').addEventListener('click', pickFile);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    openFile(file);
  });

  window.addEventListener('dragover', e => {
    e.preventDefault();
    viewer.classList.add('is-dragover');
  });
  window.addEventListener('dragleave', () => viewer.classList.remove('is-dragover'));
  window.addEventListener('drop', e => {
    e.preventDefault();
    viewer.classList.remove('is-dragover');
    openFile(e.dataTransfer?.files[0]);
  });

  for (const b of document.querySelectorAll('button[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  for (const b of document.querySelectorAll('[data-size]')) b.addEventListener('click', () => setSize(Number(b.dataset.size)));
  for (const b of document.querySelectorAll('[data-color]')) {
    b.style.setProperty('--c', b.dataset.color);
    b.addEventListener('click', () => setColor(b.dataset.color));
  }
  $('btn-copy').addEventListener('click', copy);
  $('btn-cut').addEventListener('click', cut);
  $('btn-paste').addEventListener('click', paste);
  $('btn-delete').addEventListener('click', del);
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-layer').addEventListener('click', toggleLayer);
  $('btn-theme').addEventListener('click', nextTheme);
  $('btn-save').addEventListener('click', save);
  $('btn-zoom-in').addEventListener('click', zoomIn);
  $('btn-zoom-out').addEventListener('click', zoomOut);
  $('btn-zoom-fit').addEventListener('click', zoomFit);

  let lastWheelZoom = 0;
  viewer.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !state.pdf) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheelZoom < 120 || e.deltaY === 0) return;
    lastWheelZoom = now;
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  }, { passive: false });

  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', e => {
    if (state.dirty && totalStrokes() > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const hasDoc = !!state.pdf;
  let handled = true;

  if (plain && key === 'o') pickFile();
  else if (plain && key === 't') nextTheme();
  else if (!hasDoc) handled = false;
  else if (mod && key === 'z' && e.shiftKey) redo();
  else if (mod && key === 'z') undo();
  else if (mod && key === 'y') redo();
  else if (mod && key === 'c') copy();
  else if (mod && key === 'x') cut();
  else if (mod && key === 'v') paste();
  else if (mod && key === 's') save();
  else if (mod && (key === '=' || key === '+')) zoomIn();
  else if (mod && key === '-') zoomOut();
  else if (mod && key === '0') zoomFit();
  else if (key === 'escape') { clearSelection(); updateUi(); }
  else if (plain && (key === 'delete' || key === 'backspace')) del();
  else if (plain && key === '1') setTool('pen');
  else if (plain && key === '2') setTool('erase');
  else if (plain && key === '3') setTool('select');
  else if (plain && key === '[') stepSize(-1);
  else if (plain && key === ']') stepSize(1);
  else if (plain && key === 'h') toggleLayer();
  else handled = false;

  if (handled) e.preventDefault();
}

// ---------- install / os launch ----------

function wireInstall() {
  const btn = $('btn-install');
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    deferred = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    setStatus('installed');
  });
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async p => {
      if (p.files && p.files.length) openFile(await p.files[0].getFile());
    });
  }
}

// ---------- startup ----------

setupWorker();
wire();
wireInstall();
body.dataset.tool = state.tool;
setTool(state.tool);
setSize(state.size);
setColor(state.color);
updateUi();

window.__quiksign = { state, exportPdf: exportCurrent };
