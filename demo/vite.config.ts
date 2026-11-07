import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const DEMO_PORT = 5199;
const GLOB_FROM = "['../../node_modules/pdfjs-dist/cmaps/*.bcmap', '../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../../backend/app/fonts/LiberationSans-*.ttf','../../node_modules/pdfjs-dist/wasm/*.wasm']";
const GLOB_TO = "['../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../../backend/app/fonts/LiberationSans-Regular.ttf', '../../node_modules/pdfjs-dist/wasm/jbig2.wasm']";

const WORKER_FROM = "import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';";
const WORKER_TO = "import workerUrl from 'virtual:formpdf-demo-worker';";
const WORKER_ID = '\0virtual:formpdf-demo-worker';
const WORKER_FILE = fileURLToPath(new URL('../frontend/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url));

const narrowAssets = (): Plugin => ({
  name: 'formpdf-demo-narrow-assets',
  enforce: 'pre',
  resolveId(id) { return id === 'virtual:formpdf-demo-worker' ? WORKER_ID : null; },
  load(id) {
    if (id !== WORKER_ID) return null;
    const src = readFileSync(WORKER_FILE, 'utf8');
    return `export default URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' }));`;
  },
  transform(code, id) {
    if (!id.endsWith('/frontend/src/pdf/viewer.ts')) return null;
    if (!code.includes(GLOB_FROM) || !code.includes(WORKER_FROM)) throw new Error('viewer.ts asset imports changed; update demo/vite.config.ts');
    return code.replace(GLOB_FROM, GLOB_TO).replace(WORKER_FROM, WORKER_TO);
  },
});

const classicHtml = (): Plugin => ({
  name: 'formpdf-demo-classic-html',
  enforce: 'post',
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue;
      const html = String(file.source)
        .replace(/<script type="module" crossorigin/g, '<script defer')
        .replace(/ crossorigin(="[^"]*")?/g, '');
      file.source = html;
    }
  },
});

export default defineConfig({
  root: fileURLToPath(new URL('./src', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [narrowAssets(), classicHtml()],
  server: { host: false, port: DEMO_PORT, strictPort: true, fs: { allow: ['..'] } },
  preview: { host: false, port: DEMO_PORT + 1, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('.', import.meta.url)),
    emptyOutDir: false,
    assetsDir: 'assets',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2022',
    modulePreload: false,
    chunkSizeWarningLimit: 6000,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'assets/demo.js', assetFileNames: 'assets/demo.[ext]' } },
  },
});
