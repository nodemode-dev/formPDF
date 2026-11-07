# MCP

## Shape

`routers/mcp.py` speaks MCP over HTTP POST `/mcp` (protocol 2026-07-28 and 2025-11-25, older versions accepted at initialize), with sessions in `Mcp-Session-Id`. `setup/mcp_stdio.py` bridges stdio to it, reading the port from `~/Formpdf/engine.json` and starting the engine when needed. `setup/cli.py` calls the same `call_tool` in process.

## Tools

get_context, open_pdf, pdf (actions in `READ_ACTIONS`, `CHANGE_ACTIONS`, `EXPORT_ACTIONS`), render_pages, extract, save, undo, the window command tools, and `extensions_list` and `extension_command` (window tools `extensions-list` and `extension-command`, answered by `ext/extensions.ts`).

## Extensions

Form extensions (Form Extension Contract, API 1; `docs/EXTENSIONS.md`) run in sandboxed frames in the window. Engine: `routers/extensions.py` (list, files, apply, read, manage) over the vendored `services/formext_host.py`; `/api/extensions/apply` chains `_change(..., land=False)` and the window commits once. Window: `ext/extensions.ts` over the vendored `ext/host-bridge.ts` (never edit either vendored file); the Extensions tab, menu and palette entries. Frontend HASHOUT 97, backend HASHOUT 104.

## Sources

`_source(args)`: `path` is a file; otherwise `doc` (id or key) or the window's open document, else the last PDF an agent opened (`OPEN`). Live changes go through `routes._derive` and `_land`, which records the version in `OPEN`, remembers it in recents, and when the window shows that document calls the `commit` window tool so the window switches live and labels the turn.

## Consent and turns

`_mutating` covers every action that writes or changes a file (all change and export actions, open_pdf, save, undo). Agent access is the `outsideAgents` setting, `ask`, `allowed` or `blocked` (`access()`, falling back to the old `agentsAllowed`). `call_tool` refuses every call while it is `blocked`, in-app calls included, and notes each caller in `SEEN` (`get_agent_access`, `GET /api/mcp/status`). Under `ask`, `_consent` asks the window once (120 s), persists `outsideAgents: allowed` on Yes, and caches a refusal for 120 s; the in-app token skips it; with no window connected (or when no window received the question) it refuses with `NO_WINDOW` (headless and the CLI included, unless `outsideAgents` is `allowed`). A turn is every mutating call from one session less than 90 s apart.
