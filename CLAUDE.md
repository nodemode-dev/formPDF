# formpdf for Claude Code

Two jobs happen in this repo: doing PDF work with formpdf, and developing formpdf itself.

## PDF work

The formpdf MCP server is configured in .mcp.json (http://127.0.0.1:8198/mcp). Start the app with `./formpdf` so changes appear live in the window. Workflow:

1. get_context: is the window open, which PDF is open, are agents allowed.
2. open_pdf {path} to put a PDF in front of the person, or pass `path` to a pdf action to work on a file without the window.
3. pdf {action, ...} for the job (info, text, find, header_footer, page_numbers, watermark, crop, redact, organize, protect, compress, to_docx, to_pptx and the rest). Without a path, a changing action edits the open PDF live and the person can undo your whole turn.
4. render_pages {pages} and look at the contact sheet before you say it is done; extract {kind} for text, tables or pictures.
5. save {path} only when the person asked for a file; otherwise leave the edited working copy for them to review and save.

Load `.claude/skills/formpdf-harness` for the full loop, every action with its arguments, verification by rendering, and handoff. The MCP resource formpdf://guide is the short version. For work on the codebase itself, load `.claude/skills/formpdf-skillset`.

## Developing formpdf

- Engine: backend/ (FastAPI, Python 3.12, venv at backend/venv, port 8198). Frontend: frontend/ (vanilla TypeScript, Vite on 5198 with host false). Desktop: src-tauri/.
- Edits are surgical, one region at a time; no scripted edits. Near-zero comments: rationale goes in frontend/HASHOUT_LOG.md and backend/HASHOUT_LOG.md.
- No emoji, no em dashes in markdown, icons are inline currentColor SVG in ui/icons.ts, z-index only from tokens.css.
- Zero DOM flash: patch nodes, never rebuild a live container; verify under 4x CPU and network throttling.
- No tests in the repo; checks run from a scratch folder. Licences stay permissive (no PyMuPDF, pdf2docx or ghostscript).
- Commits: Conventional Commits `type(scope): summary (x.y.z)` with a body, version bump commit last.
