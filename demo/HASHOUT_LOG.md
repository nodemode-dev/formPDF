# demo HASHOUT_LOG

Why the browser demo is built the way it is. Anchored by file and symbol.

## Org navi map

```
src/index.html     page shell, favicon
src/main.ts        imports the app's tokens, shell, dialogs and pdf styles, then start()
src/app.ts         window markup, state, tabs, organize grid, find, merge, stamps, download, drop
src/pdfops.ts      pdf-lib operations: applyPlan, extractPages, mergeInto, numberPages, watermark
src/sample.ts      the generated sample document
src/demo.css       demo-only layout (dm- classes) and small fixes over pdf.css
vite.config.ts     narrowAssets, classicHtml, build options
index.html assets/ committed build output
```

## TOC

1. Reuse the real viewer, not a copy · src/app.ts, vite.config.ts narrowAssets
2. Classic script and inlined assets for file:// · vite.config.ts classicHtml, build
3. The worker on file:// · vite.config.ts virtual:formpdf-demo-worker
4. pdf-lib writes, pdf.js reads · src/pdfops.ts
5. Organize is a plan applied in one step · src/app.ts plan, applyPlan
6. Zero shift rules kept · src/app.ts patchList, setTab

## 1. Reuse the real viewer, not a copy

`Viewer`, `Thumbs` and `Finder` only need a URL, page sizes and a hooks object, so the demo imports them from `frontend/src/pdf/` and feeds them a blob URL. The backend shim is therefore nothing: no route is called. The viewer's page sizes come from a throwaway pdf.js open (`measure`) because `Viewer.load` takes sizes up front. `narrowAssets` rewrites the viewer's `import.meta.glob` list at build time, not on disk, to drop the CJK maps and wasm decoders (about 3 MB) and keep the standard fonts; it throws if the line changes so a drift is loud.

## 2. Classic script and inlined assets for file:// 

Chrome refuses `type="module"` scripts and `fetch` of sibling files from file://. The build is one IIFE, `classicHtml` swaps the module tag for `defer` and drops `crossorigin`, and `assetsInlineLimit` turns fonts, standard font data and the logo into data URIs so `fetch` of them works. The output keeps fixed names (`assets/demo.js`, `assets/demo.css`) so rebuilds replace files instead of piling up hashed ones. `dist/` is in .gitignore, which is why the build lands in `demo/` itself.

## 3. The worker on file://

A module worker cannot start from a blob or file URL on file://, so pdf.js falls back to parsing on the main thread and warns once. The worker source is still turned into a blob URL by `virtual:formpdf-demo-worker` so that the same build starts a real worker when served over http. Pages are light enough that the main-thread path stays smooth.

## 4. pdf-lib writes, pdf.js reads

pdf.js cannot write PDFs and the app's engine is Python, so the demo needs a small client-side writer. pdf-lib is MIT, has no dependencies that need a licence row beyond its own, and copies pages between documents, which is all rotate, reorder, extract and merge need. Page numbers and the watermark map the visual position through the page's /Rotate (`place`) so they land the right way up on rotated pages.

## 5. Organize is a plan applied in one step

Like the app, Organize edits a list of cards (`plan`: source page and added rotation) and nothing is written until Apply changes. Reset rebuilds the identity plan. Rotation is a CSS transform on a card whose box was sized for the rotated bounds, so the card does not change size mid-turn. Drag and drop moves the whole selection and a marker shows the drop slot.

## 6. Zero shift rules kept

Every list (cards, hits, queue) is patched with `patchList`; static markup is mounted once with `mountOnce`. Switching to Organize parks the viewer and unparks it on return so the scroll position survives. Theme is the app's studio dark from `tokens.css` on `:root`, so there is no theme swap after first paint. The page background is set inline in `index.html` before the stylesheet arrives. z-index values come only from `tokens.css`, except one override of `.fs-pdfwb` to `var(--z-base)` because the demo window is not an overlay.
