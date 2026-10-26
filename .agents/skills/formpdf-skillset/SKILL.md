---
name: formpdf-skillset
description: "Guides development of the formpdf codebase: its FastAPI engine, vanilla TypeScript and Vite PDF workbench, MCP server and Tauri desktop shell. Use whenever a task changes, fixes, reviews or explains formpdf code: the PDF services (core, edit, annot, forms, layout, word, slides, sanitize, search, create, compare, docs), the /api/pdf routes, the live channel and window tools, the MCP tools and the headless CLI, the pdf.js viewer, thumbnails, reading mode, annotate, fill and sign, prepare form, organize, extract, protect and convert panes, Home, menus, dialogs and styles, the sidecar freeze, or a UI flicker, flash or layout shift. Trigger on formpdf with backend/app, frontend/src, src-tauri, setup, HASHOUT_LOG, port 8198 or 5198, or adding a pdf action, a pane control or an MCP tool. Encodes the repo laws. Not for doing PDF work with formpdf (use formpdf-harness)."
license: Apache-2.0
metadata:
  author: formpdf
  version: "0.56.7"
---

# formpdf skillset

formpdf is a PDF editor: a Python 3.12 FastAPI engine (`backend/`, port 8198) that keeps every PDF as immutable working copies, a vanilla TypeScript 7 and Vite 8 window (`frontend/`, port 5198, no framework) built around the PDF workbench, and a Tauri 2 shell (`src-tauri/`) that runs the frozen engine as a sidecar. It was extracted from formsld 0.5.1; the laws and the design language are the same.

## File maps

`references/file-maps.md` maps every file. In short:

| Area | Root |
| --- | --- |
| PDF services | `backend/app/services/pdf/` (core, edit, annot, forms, layout, word, slides, sanitize, search, create, compare, docs) |
| REST routes | `backend/app/routers/pdf.py` (`_run` error mapping, `_derive` new versions), `system.py`, `media.py` |
| Live channel and window tools | `backend/app/routers/live.py`, `backend/app/services/bridge.py`, `frontend/src/live/socket.ts`, `frontend/src/live/agent.ts` |
| MCP server | `backend/app/routers/mcp.py`, `setup/mcp_stdio.py`, `setup/cli.py` |
| Viewer | `frontend/src/pdf/viewer.ts` (pdf.js, layouts, thumbnails), `reading.ts`, `find.ts` |
| Workbench tabs | `frontend/src/pdf/workbench.ts` (shell, history, menus, agent turns), `panels.ts` (side panes), `annotate.ts`, `stamps.ts`, `fill.ts`, `form.ts`, `organize.ts`, `compare.ts`, `create.ts`, `api.ts` |
| Home and shell | `frontend/src/app.ts`, `ui/home.ts`, `ui/app-dialogs.ts`, `ui/` toolkit, `styles/` |
| Desktop | `src-tauri/`, `backend/formpdf_engine.py`, `setup/freeze_backend` (releases are built by formcompiler) |

## Laws

`references/repo-laws.md` has each law with its reason. In short: surgical one-region edits by hand; near-zero comments with rationale in the HASHOUT logs; no emoji, no em dashes; icons inline currentColor SVG from `ui/icons.ts`; z-index only from `styles/tokens.css`; zero DOM flash and zero layout shift; tests only as FAMILY_TEST_PLAN names them, in `backend/tests`, run in CI; permissive licences only (no PyMuPDF, pdf2docx, ghostscript); Conventional Commits with the version bump last.

## Routing

| Task | Read |
| --- | --- |
| A new PDF operation | `references/engine.md`, then `references/workbench.md` for its pane, then `references/mcp.md` to expose it |
| A pane control, a tab, the viewer, thumbnails, reading mode | `references/workbench.md`, then `references/verification.md` |
| A new MCP tool, consent, turns, live edits | `references/mcp.md` |
| Home, menus, dialogs, themes | `references/workbench.md` (shell section), then `references/verification.md` |
| Desktop build, sidecar | `references/file-maps.md` desktop section |
| Before handing back anything visible | `references/verification.md` |

## Running it

```text
./formpdf install            backend venv and frontend packages
./formpdf                    engine 127.0.0.1:8198 and Vite 5198 together
./formpdf serve              the built frontend served by the engine (FORMPDF_DIST)
./formpdf run <action> f.pdf a PDF job without the window
./formpdf doctor             toolchain, installs and ports
cd frontend && npx tsc --noEmit && npx vite build
cd backend && venv/bin/python -m compileall -q app
```

Scratch engines: `FORMPDF_PORT=[port] FORMPDF_DATA_DIR=[scratch]/data FORMPDF_DIST=../frontend/dist venv/bin/python -m uvicorn app.main:app --port [port]` from `backend/`, stopped by PID.

## Done means

- Laws followed; `npx tsc --noEmit` clean; `vite build` ok; the engine boots and `/api/health` answers.
- The changed flow was exercised in the built app under throttling with zero console errors and zero layout shift (`references/verification.md`).
- A new operation works through REST, the window (with undo back) and the MCP `pdf` tool; the harness `pdf-actions.md` lists it.
- HASHOUT entries written for non-obvious decisions; commits shaped as in `references/repo-laws.md`.
