import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const safe = js => js.replace(/<\/script/gi, '<\\/script');
const fill = (html, key, value) => html.split(key).join(value);

const result = await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: 'es2020',
});
const app = result.outputFiles[0].text;

const css = read('src/style.css');
const pdfjs = read('node_modules/pdfjs-dist/build/pdf.min.js');
const worker = read('node_modules/pdfjs-dist/build/pdf.worker.min.js');
const pdflib = read('node_modules/pdf-lib/dist/pdf-lib.min.js');

let html = read('src/index.html');
html = fill(html, '/*__CSS__*/', css);
html = fill(html, '/*__PDFJS_WORKER__*/', safe(worker));
html = fill(html, '/*__PDFJS__*/', safe(pdfjs));
html = fill(html, '/*__PDFLIB__*/', safe(pdflib));
html = fill(html, '/*__APP__*/', safe(app));

mkdirSync('dist', { recursive: true });
writeFileSync('dist/nib.html', html);
console.log(`built dist/nib.html ${Math.round(Buffer.byteLength(html) / 1024)} KB`);
