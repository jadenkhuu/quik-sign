import { strokeToSvgPath } from './ink.js';

function hexToRgb(hex) {
  const { rgb } = globalThis.PDFLib;
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Returns new PDF bytes with each page's strokes drawn on top. pages: [{ viewport (pdf.js, scale 1), strokes }]. */
export async function exportPdf(originalBytes, pages) {
  const { PDFDocument, LineCapStyle } = globalThis.PDFLib;
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  pages.forEach(({ viewport, strokes }, i) => {
    if (!strokes.length) return;
    const p = doc.getPage(i);
    for (const s of strokes) {
      p.drawSvgPath(strokeToSvgPath(s, (x, y) => viewport.convertToPdfPoint(x, y)), {
        x: 0,
        y: 0,
        borderColor: hexToRgb(s.color),
        borderWidth: s.width,
        borderLineCap: LineCapStyle.Round,
      });
    }
  });
  doc.setProducer('quik-sign');
  return await doc.save();
}
