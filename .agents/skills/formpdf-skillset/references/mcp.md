# MCP

## Shape

`routers/mcp.py` speaks MCP over HTTP POST `/mcp` (protocol 2026-07-28 and 2025-11-25, older versions accepted at initialize), with sessions in `Mcp-Session-Id`. `setup/mcp_stdio.py` bridges stdio to it, reading the port from `~/Formpdf/engine.json` and starting the engine when needed. `setup/cli.py` calls the same `call_tool` in process.

## Tools

get_context, open_pdf, pdf (actions in `READ_ACTIONS`, `CHANGE_ACTIONS`, `EXPORT_ACTIONS`), render_pages, extract, save, undo.

## Sources

`_source(args)`: `path` is a file; otherwise `doc` (id or key) or the window's open document, else the last PDF an agent opened (`OPEN`). Live changes go through `routes._derive` and `_land`, which records the version in `OPEN`, remembers it in recents, and when the window shows that document calls the `commit` window tool so the window switches live and labels the turn.

## Consent and turns

`_mutating` covers every action that writes or changes a file (all change and export actions, open_pdf, save, undo). `_consent` asks the window once (120 s), persists `agentsAllowed`, and caches a refusal for 120 s; with no window connected it proceeds (headless and CLI). A turn is every mutating call from one session less than 90 s apart.
