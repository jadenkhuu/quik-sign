import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const safe = js => js.replace(/<\/script/gi, '<\\/script');
const fill = (html, key, value) => html.split(key).join(value);
const kb = text => Math.round(Buffer.byteLength(text) / 1024);

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
const iconSvg = read('assets/icon.svg').trim();
const { version } = JSON.parse(read('package.json'));

let html = read('src/index.html');
html = fill(html, '/*__CSS__*/', css);
html = fill(html, '/*__PDFJS_WORKER__*/', safe(worker));
html = fill(html, '/*__PDFJS__*/', safe(pdfjs));
html = fill(html, '/*__PDFLIB__*/', safe(pdflib));
html = fill(html, '/*__APP__*/', safe(app));

const pwaHead = '<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#0f0f10"><link rel="icon" href="icon.svg">'
  + "<script>if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js');</script>";
const offlineHead = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(iconSvg)}">`;

const indexHtml = fill(html, '<!--__PWA_HEAD__-->', pwaHead);
const offlineHtml = fill(html, '<!--__PWA_HEAD__-->', offlineHead);

const manifest = {
  name: 'quik-sign',
  short_name: 'quik-sign',
  description: 'Sign PDFs with a pen. Nothing is uploaded',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#141415',
  theme_color: '#0f0f10',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
  file_handlers: [{ action: './', accept: { 'application/pdf': ['.pdf'] } }],
};

const manifestText = JSON.stringify(manifest, null, 2) + '\n';

// Version the service worker by every cached asset, in the same order as ASSETS in src/sw.js.
const icons = ['icon.svg', 'icon-192.png', 'icon-512.png'];
const hasher = createHash('sha256').update(indexHtml).update(manifestText);
for (const f of icons) hasher.update(readFileSync(`assets/${f}`));
const hash = hasher.digest('hex').slice(0, 8);
const sw = fill(read('src/sw.js'), '__VERSION__', `${version}-${hash}`);

mkdirSync('docs', { recursive: true });
writeFileSync('docs/index.html', indexHtml);
writeFileSync('docs/quik-sign.html', offlineHtml);
writeFileSync('docs/manifest.webmanifest', manifestText);
writeFileSync('docs/sw.js', sw);
for (const f of icons) copyFileSync(`assets/${f}`, `docs/${f}`);

console.log(`built docs/index.html ${kb(indexHtml)} KB, docs/quik-sign.html ${kb(offlineHtml)} KB, sw ${version}-${hash}`);
