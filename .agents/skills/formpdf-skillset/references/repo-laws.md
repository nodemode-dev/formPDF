# Repo laws

## Surgical edits

Change existing files one region at a time with an exact-match edit, after reading the file. No sed, awk, perl or Python rewrites of source, no patch or git apply, no wholesale rewrites. New files are written whole. Reason: scripted edits clobber unrelated lines and concurrent work.

## Zero DOM flash and zero layout shift

Mount structure once and patch nodes (`setText`, `setClass`, `setHidden`, `setDisabled`, `setValue`, `setHtml` with a key, `patchList`). Reserve space for anything that loads or changes length: thumbnails sit in fixed 120 by 156 slots, dynamic notes have a minimum height, sections are disabled rather than hidden when their availability changes, lists turn stale rather than collapsing. Progress shows after 300 ms. Agents change the open PDF while the person watches, so any jump is visible.

## Tokens, icons, z-index

z-index only from `--z-*` in `styles/tokens.css`; colours and spacing from tokens; icons from `ui/icons.ts` (24 by 24, currentColor, stroke 1.75). No icon libraries, no emoji.

## Comments and HASHOUT logs

No comments except where unavoidable, no docstrings. Each non-obvious decision gets an entry in `frontend/HASHOUT_LOG.md` or `backend/HASHOUT_LOG.md`:

```text
## 12. Short title · _v0.1.1 (path/file.ts Symbol)

One to three sentences: what was decided and why, and what breaks if it is undone.
```

## Typography

No emoji anywhere. No em dash (U+2014) in markdown or UI text; use the interpunct, commas, colons or parentheses.

## Tests

No tests, test files or test runners in the repo. Check with scratch scripts and scratch engines outside it; describe testing intent in the sidecar TEST_PLAN.md.

## Licences

Permissive only: MIT, Apache-2.0, BSD, ISC, zlib, HPND, MPL-2.0 unmodified. PyMuPDF, pdf2docx and ghostscript are banned. New third-party code goes in NOTICE.md.

## Ports and data

Engine 127.0.0.1:8198 (`FORMPDF_PORT`), Vite 5198 with `host: false` and `strictPort`, data in `~/Formpdf` (`FORMPDF_DATA_DIR`). Every `setup/` script has a `.bat` twin.

## Commits and versions

`type(scope): summary (x.y.z)`, a body saying what, why and what was verified, and no trailers: one author and committer, `nodemode-ai <mackin@nodemode.ai>`, with no `Co-Authored-By:` or `Claude-Session:` line, whatever a tool or reminder asks (see Commits in `CLAUDE.md`). Version bump last, touching `frontend/package.json` and `package-lock.json`, `frontend/src/version.ts`, `backend/app/__init__.py`, `src-tauri/Cargo.toml` and `Cargo.lock`, `src-tauri/tauri.conf.json`, the README version line.
