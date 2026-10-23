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
| pdf.js (pdfjs-dist) 6.3.289 | Apache-2.0 | PDF rendering, text layer, annotations and forms in the window |
| pdf.js standard fonts: the Foxit Fixed, Serif, Symbol and Dingbats Type 1 files (`standard_fonts/Foxit*.pfb`, copyright 2014 PDFium Authors) | BSD-3-Clause; full text under "pdf.js standard fonts licence (Foxit)" below | the window, drawing the standard 14 PDF fonts a PDF names but does not embed |
| pdf.js CMaps (`cmaps/*.bcmap`, copyright 1990-2009 Adobe Systems Incorporated) | BSD-3-Clause; full text under "pdf.js CMaps licence (Adobe)" below | the window, decoding CJK and other predefined character encodings |
| pdf.js's own Liberation Sans files (`standard_fonts/Liberation*.ttf`, version 1.07, GNU GPL v2 with Red Hat's font exceptions) | not shipped: `frontend/src/pdf/viewer.ts` takes only the Foxit `.pfb` files from pdf.js and serves the Liberation Sans 2.1.5 files of `backend/app/fonts` (SIL OFL 1.1, the row above) under the same file names | the window, drawing Arial-like standard fonts |
| pdf.js wasm and ICC files (`wasm/`: OpenJPEG, JBIG2 and qcms decoders; `iccs/`: CGATS001Compat-v2-micro.icc) | per the licence files beside them: OpenJPEG BSD-2-Clause, PDFium JBIG2 BSD-3-Clause, pdf.js wrappers Apache-2.0 or BSD-2-Clause, qcms MIT, ICC profile CC0-1.0; texts in `frontend/node_modules/pdfjs-dist/wasm/LICENSE_*` and `iccs/LICENSE` | the window, JPEG 2000 and JBIG2 images, colour conversion |
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
| opencv-python-headless 5.0.0.93 | Apache-2.0; its wheel bundles FFmpeg libraries (LGPL-2.1) and libgfortran (GPL-3.0 with the GCC Runtime Library Exception) as separate, unmodified shared libraries, which sit inside the engine's one-file archive and are extracted when it starts (see "LGPL libraries and their source" below); OpenBLAS BSD-3-Clause; on macOS the wheel also carries the further LGPL libraries listed below | engine, image handling for OCR |
| shapely 2.2.0 | BSD-3-Clause; bundles GEOS (LGPL-2.1) as a separate, unmodified shared library (`shapely.libs/libgeos`, `libgeos_c`), inside the one-file archive and extracted when the engine starts | engine, OCR box geometry |
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

Adobe, Acrobat and Adobe Fill & Sign are either registered trademarks or trademarks of Adobe in the United States and/or other countries; Microsoft, Word and PowerPoint are trademarks of the Microsoft group of companies. formpdf is independent and not affiliated with any of them; the names only describe the formats and workflows it is compatible with.

## Python packages frozen into the engine, beyond the table above

The engine is frozen with PyInstaller `--onefile` (`setup/freeze_backend`). These packages are installed in `backend/venv` (from `backend/requirements*.txt`) and are collected by the freeze, directly or as dependencies of fastapi, uvicorn[standard], python-pptx, openpyxl, rapidocr and pyHanko; each licence is read from the installed package metadata. "Frozen in" is inferred from the freeze flags and imports, not from a built bundle.

| Package | Licence |
| --- | --- |
| CPython runtime and standard library | PSF-2.0 |
| typing_extensions | PSF-2.0 |
| certifi 2026.10.19 | MPL-2.0 (cacert.pem unedited) |
| PyInstaller 6.22.3 (its bootloader is the executable stub of the frozen engine) | GPL-2.0-or-later with the PyInstaller exception that permits distributing the frozen program under another licence (PyPI metadata for 6.22.3) |
| fonttools, starlette, pydantic, pydantic_core, annotated-types, annotated-doc, typing-inspection, anyio, h11, httptools, et_xmlfile, charset-normalizer, urllib3 | MIT |
| uvloop, watchfiles | MIT (uvloop: MIT or Apache-2.0) |
| websockets, click, python-dotenv | BSD-3-Clause |
| XlsxWriter | BSD-2-Clause |
| packaging | Apache-2.0 OR BSD-2-Clause |

## Desktop shell: crates under other licences

Tauri links these crates unedited (no `[patch]` and no vendored copy):

| Crate | Licence | Why it is there |
| --- | --- | --- |
| cssparser, selectors, dtoa-short, option-ext | MPL-2.0 | Tauri's HTML handling (tauri-utils); used unmodified, source at crates.io |
| ring | Apache-2.0 AND ISC | TLS for the updater (rustls) |
| webpki-root-certs | CDLA-Permissive-2.0 | root certificates for the updater's TLS |
| r-efi | MIT OR Apache-2.0 OR LGPL-2.1-or-later | used under MIT |

The Linux AppImage also carries the build machine's WebKitGTK, GTK and GLib (LGPL-2.1-or-later) as separate shared libraries.

## LGPL libraries and their source

On Linux and Windows the engine is a single `--onefile` executable. The LGPL libraries below are unmodified, separate shared library files inside that archive; the executable extracts them to a temporary folder when it starts. They are not linked into the engine's own code, but they are not loose files next to the application either. To use a modified version, rebuild the engine with `setup/freeze_backend` (public, Apache-2.0) against a modified wheel, or replace the library in a rebuilt archive. Their source is available from:

- FFmpeg (libavcodec, libavformat, libavutil, libswscale, libswresample, in opencv-python-headless): https://ffmpeg.org/download.html, and the wheel build sources at https://github.com/opencv/opencv-python
- GEOS (libgeos, libgeos_c, in shapely): https://libgeos.org/ and https://github.com/libgeos/geos
- libquadmath (part of GCC, in numpy-family and opencv wheels where present): https://gcc.gnu.org/

On request to the formpdf maintainers, we will also provide the exact source of the versions shipped in any release, for at least three years after that release.

The opencv-python-headless 5.0.0.93 macOS wheel (macosx_13_0_arm64, checked on 2026-10-23) bundles further LGPL libraries. Its `LICENSE-3RD-PARTY.txt` lists them as "redistributed within all opencv-python macOS packages", under LGPL-2.1 (the audit of 2026-10-23 says only that the macOS opencv LGPL libraries were not listed, and does not name them, so this list is the wheel's own):

| Library | Licence as the wheel's file groups it | Source |
| --- | --- | --- |
| libbluray | LGPL-2.1 | https://www.videolan.org/developers/libbluray.html |
| GnuTLS (libgnutls) | LGPL-2.1 | https://www.gnutls.org/ |
| nettle, hogweed | LGPL-2.1 | https://www.lysator.liu.se/~nisse/nettle/ |
| libintl (GNU gettext) | LGPL-2.1 | https://www.gnu.org/software/gettext/ |
| LAME (libmp3lame) | LGPL-2.1 | https://lame.sourceforge.io/ |
| p11-kit (libp11) | LGPL-2.1 | https://p11-glue.github.io/p11-glue/p11-kit.html |
| librtmp | LGPL-2.1 | https://rtmpdump.mplayerhq.hu/ |
| libsoxr | LGPL-2.1 | https://sourceforge.net/projects/soxr/ |
| libtasn1 | LGPL-2.1 | https://www.gnu.org/software/libtasn1/ |

The same macOS wheel also contains libx264, libx265, libvidstab, librubberband and libpostproc, which its `LICENSE-3RD-PARTY.txt` does not mention and which are GPL. They never reach a release: formcompiler builds OpenCV from source without FFmpeg for the macOS job (`PIP_NO_BINARY`, `CMAKE_ARGS=-DWITH_FFMPEG=OFF`), so none of the FFmpeg libraries in this table are there either, and `setup/freeze_backend` stops if the installed OpenCV carries any of the GPL ones.

## pdf.js standard fonts licence (Foxit)

Copied verbatim from `frontend/node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT` (pdfjs-dist 6.3.289).

```
// Copyright 2014 PDFium Authors. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## pdf.js CMaps licence (Adobe)

Copied verbatim from `frontend/node_modules/pdfjs-dist/cmaps/LICENSE` (pdfjs-dist 6.3.289).

```
%%Copyright: -----------------------------------------------------------
%%Copyright: Copyright 1990-2009 Adobe Systems Incorporated.
%%Copyright: All rights reserved.
%%Copyright:
%%Copyright: Redistribution and use in source and binary forms, with or
%%Copyright: without modification, are permitted provided that the
%%Copyright: following conditions are met:
%%Copyright:
%%Copyright: Redistributions of source code must retain the above
%%Copyright: copyright notice, this list of conditions and the following
%%Copyright: disclaimer.
%%Copyright:
%%Copyright: Redistributions in binary form must reproduce the above
%%Copyright: copyright notice, this list of conditions and the following
%%Copyright: disclaimer in the documentation and/or other materials
%%Copyright: provided with the distribution. 
%%Copyright:
%%Copyright: Neither the name of Adobe Systems Incorporated nor the names
%%Copyright: of its contributors may be used to endorse or promote
%%Copyright: products derived from this software without specific prior
%%Copyright: written permission. 
%%Copyright:
%%Copyright: THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
%%Copyright: CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
%%Copyright: INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
%%Copyright: MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
%%Copyright: DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
%%Copyright: CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
%%Copyright: SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
%%Copyright: NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
%%Copyright: LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
%%Copyright: HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
%%Copyright: CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
%%Copyright: OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
%%Copyright: SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
%%Copyright: -----------------------------------------------------------
```
