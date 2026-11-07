import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const GLOB_FROM = "['../../node_modules/pdfjs-dist/cmaps/*.bcmap', '../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../../backend/app/fonts/LiberationSans-*.ttf','../../node_modules/pdfjs-dist/wasm/*.wasm']";
const GLOB_TO = "['../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../../backend/app/fonts/LiberationSans-Regular.ttf', '../../node_modules/pdfjs-dist/wasm/jbig2.wasm']";
const WORKER_FROM = "import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';";
const WORKER_TO = "import workerUrl from 'virtual:formpdf-protect-worker';";
const WORKER_ID = '\0virtual:formpdf-protect-worker';
const WORKER_FILE = here('../../frontend/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs');

const narrowAssets = () => ({
  name: 'formpdf-protect-narrow-assets',
  enforce: 'pre',
  resolveId(id) { return id === 'virtual:formpdf-protect-worker' ? WORKER_ID : null; },
  load(id) {
    if (id !== WORKER_ID) return null;
    const src = readFileSync(WORKER_FILE, 'utf8');
    return `export default URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' }));`;
  },
  transform(code, id) {
    if (!id.endsWith('/frontend/src/pdf/viewer.ts')) return null;
    if (!code.includes(GLOB_FROM) || !code.includes(WORKER_FROM)) throw new Error('viewer.ts asset imports changed; update demos/protect/vite.config.mjs');
    return code.replace(GLOB_FROM, GLOB_TO).replace(WORKER_FROM, WORKER_TO);
  },
});

const classicHtml = () => ({
  name: 'formpdf-protect-classic-html',
  enforce: 'post',
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue;
      file.source = String(file.source).replace(/<script type="module" crossorigin/g, '<script defer').replace(/ crossorigin(="[^"]*")?/g, '');
    }
  },
});

export default {
  root: here('./src'),
  base: './',
  publicDir: false,
  plugins: [narrowAssets(), classicHtml()],
  resolve: { alias: { 'pdf-lib': here('../../demo/node_modules/pdf-lib/es/index.js'), 'pdfjs-dist': here('../../frontend/node_modules/pdfjs-dist') } },
  server: { host: false, port: 5299, strictPort: true, fs: { allow: ['../..'] } },
  preview: { host: false, port: 5300, strictPort: true },
  build: {
    outDir: here('./'),
    emptyOutDir: false,
    assetsDir: 'assets',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2022',
    modulePreload: false,
    chunkSizeWarningLimit: 6000,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'assets/protect.js', assetFileNames: 'assets/protect.[ext]' } },
  },
};
