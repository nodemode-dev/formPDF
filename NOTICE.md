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

## Build tools, not distributed

| Tool | License |
| --- | --- |
| TypeScript, Vite, @tauri-apps/cli | Apache-2.0, MIT, MIT or Apache-2.0 |
| PyInstaller | GPL-2.0 with the bootloader exception, which permits distributing the frozen engine |

No GPL or AGPL library is used by the engine or the window: PyMuPDF, pdf2docx and ghostscript are deliberately not used.

Adobe and Acrobat are trademarks of Adobe Inc.; Microsoft, Word and PowerPoint are trademarks of the Microsoft group of companies. formpdf is independent and not affiliated with any of them; the names only describe the formats and workflows it is compatible with.
