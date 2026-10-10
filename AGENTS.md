# formpdf for Codex, Cursor and other agents

formpdf exposes an MCP server at http://127.0.0.1:8198/mcp (stdio: `python3 setup/mcp_stdio.py`, which finds the engine through ~/Formpdf/engine.json and starts it when needed). Configs: .codex/config.toml, .cursor/mcp.json, .mcp.json. Run `./formpdf agents install` to install them and the skills for your home folder too.

PDF work: get_context · open_pdf (absolute path) · pdf {action} (live on the open PDF, or on a file with `path`) · render_pages to look · extract for text, tables and pictures · save when asked · undo reverts your last turn. The skill packs live in .agents/skills: formpdf-harness (doing PDF work) and formpdf-skillset (developing formpdf). The short guide is the resource formpdf://guide. Scripted jobs without the window: `./formpdf run <action> file.pdf ...`.

Developing formpdf follows CLAUDE.md: surgical edits, near-zero comments with rationale in the HASHOUT logs, no emoji, inline SVG icons, tokens-only z-index, zero DOM flash, no tests in the repo, Conventional Commits with the version bump last.
