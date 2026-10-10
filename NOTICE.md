# Third-party notices

formpdf is licensed under the Apache License 2.0 (see `LICENSE`). It includes or depends on the following works.

## Included in this repository

| Work | License | Where |
| --- | --- | --- |
| formsld (https://github.com/nodemode-ai/formsld, 0.5.1), same owner: the PDF workbench, its engine services and routes, the MCP server and stdio bridge shape, the dispatcher and setup scripts and the Tauri shell, moved out of formsld into this repository | Apache-2.0 | `frontend/src/pdf/`, `backend/app/services/pdf/`, `backend/app/routers/`, `formpdf`, `setup/`, `src-tauri/` |
| formvis (https://github.com/nodemode-ai/formvis, through formsld), same owner: the form family design system (tokens, 14 theme profiles, the pre-paint theme boot, the DOM toolkit, command registry, menus, dialogs, dropdowns, toasts, icon set) | Apache-2.0 | `frontend/index.html`, `frontend/src/styles/`, `frontend/src/ui/` |
| NodeMode stylized design system (through formvis): tokens, theme profiles, theme boot, dom-stable helpers, icon subset | MIT | `frontend/src/styles/tokens.css`, `frontend/src/ui/themes.ts`, `frontend/src/ui/dom.ts`, `frontend/src/ui/icons.ts` |
| `paintbrush` and `hand` icons from Remix Icon (through formvis) | Apache-2.0 | `frontend/src/ui/icons.ts` |

The formpdf mark, the stamps and the agent skills are original work of this repository.

## Distributed with the app

| Package | License | Notes |
| --- | --- | --- |
| Inter, JetBrains Mono and Caveat (via @fontsource) | SIL OFL 1.1 fonts, MIT packaging | interface, code and typed signature fonts |
| Inter 4.1, Noto Serif 2.015 and JetBrains Mono 2.304 TrueType files, four styles each, with their licence texts | SIL OFL 1.1 | `backend/app/fonts/`: the engine's font kit, embedded as subsets in text formpdf writes into PDFs |
| Liberation Sans, Serif and Mono 2.1 TrueType files (copyright Google and Red Hat, Reserved Font Names Arimo, Tinos, Cousine and Liberation), four styles each, unmodified, with Liberation-OFL.txt | SIL OFL 1.1 | `backend/app/fonts/`: embedded in place of fonts a PDF names but does not include (Helvetica, Times, Courier and their kin, which Liberation matches in width) when converting to PDF/A or PDF/X and in preflight fixups |
| sRGB output intent profile | generated at run time by LittleCMS through Pillow's ImageCms (MIT-style licence), not a copied profile | engine, PDF/A output intent |
| en_US Hunspell dictionary from SCOWL (2020.12.07, size 60), with its README and licence text | SCOWL permissive notice (Kevin Atkinson), Ispell BSD-style licence (Geoff Kuenning), WordNet 1.6 licence, public-domain sources; notices kept verbatim | `backend/app/dict/en_US/`: the engine's spelling dictionary, read by formpdf's own Hunspell-format reader |
| pdf.js (pdfjs-dist) | Apache-2.0 | PDF rendering, text layer, annotations and forms in the window |
| @tauri-apps/api; tauri, tauri-plugin-shell, tauri-plugin-dialog, tauri-plugin-updater, tauri-plugin-single-instance, regex, serde, serde_json | MIT or Apache-2.0 | desktop shell |
| fastapi, uvicorn, python-multipart | MIT, BSD-3-Clause, Apache-2.0 | engine |
| Pillow | MIT-CMU | engine, pictures and contact sheets |
| lxml | BSD-3-Clause | engine, Office XML |
| python-pptx, python-docx, openpyxl | MIT | engine, PDF to PowerPoint, PDF to Word, tables to Excel |
| pypdf | BSD-3-Clause | engine, organise, protect, stamp, forms, sanitise |
| pypdfium2 with PDFium | Apache-2.0 or BSD-3-Clause; PDFium BSD-3-Clause | engine, rendering, redaction and image extraction |
| pdfplumber, pdfminer.six | MIT | engine, text, layout and tables |
| reportlab | BSD | engine, PDF composition |
| rapidocr 3.10.0 with the PP-OCRv6 small detection and recognition models and the PaddleOCR mobile direction classifier | Apache-2.0 (code by the RapidOCR Authors; model weights by Baidu and the PaddleOCR rights holders, see its MODEL_LICENSES.md) | engine, text recognition (optional; installed by default) |
| onnxruntime | MIT | engine, runs the OCR models on this computer |
| opencv-python-headless | Apache-2.0; its wheel bundles FFmpeg libraries (LGPL-2.1) and libgfortran (GPL-3.0 with the GCC Runtime Library Exception) as separate shared libraries, kept unmodified and replaceable; OpenBLAS BSD-3-Clause | engine, image handling for OCR |
| shapely | BSD-3-Clause; bundles GEOS (LGPL-2.1) as a separate, unmodified shared library | engine, OCR box geometry |
| pyclipper, PyYAML, colorlog, six | MIT | engine, OCR dependencies |
| omegaconf (with ANTLR 4 runtime notice), numpy, protobuf | BSD-3-Clause (numpy also 0BSD, MIT, Zlib, CC0-1.0 parts) | engine, OCR dependencies |
| flatbuffers, requests | Apache-2.0 | engine, OCR dependencies (requests is never used to reach the network: models are looked up on disk only) |
| tqdm | MPL-2.0 and MIT, files unmodified | engine, OCR dependency |
| pyHanko 0.37.0, pyhanko-certvalidator, asn1crypto, oscrypto, uritools, tzlocal, attrs | MIT | engine, digital signatures: signing, timestamps and validation |
| cryptography | Apache-2.0 or BSD-3-Clause | engine, digital IDs and signature maths |
| cffi, pycparser, idna | MIT-0, BSD-3-Clause, BSD-3-Clause | engine, signing dependencies |
| aiohttp, aiosignal, frozenlist, multidict, propcache, yarl | Apache-2.0 (aiohttp also MIT parts) | engine, signing dependencies (reached only for a timestamp server the person sets) |
| aiohappyeyeballs | PSF-2.0 | engine, signing dependency |
| certifi | MPL-2.0, files unmodified | engine, signing dependency |

## Build tools, not distributed

| Tool | License |
| --- | --- |
| TypeScript, Vite, @tauri-apps/cli | Apache-2.0, MIT, MIT or Apache-2.0 |
| PyInstaller | GPL-2.0 with the bootloader exception, which permits distributing the frozen engine |
| veraPDF (validation during development only, never shipped or called by formpdf) | GPL-3.0 or MPL-2.0 |

No GPL or AGPL library is used by the engine or the window: PyMuPDF, pdf2docx and ghostscript are deliberately not used.

Adobe and Acrobat are trademarks of Adobe Inc.; Microsoft, Word and PowerPoint are trademarks of the Microsoft group of companies. formpdf is independent and not affiliated with any of them; the names only describe the formats and workflows it is compatible with.
