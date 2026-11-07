# formpdf MCP tools

Server name `formpdf`, HTTP at `http://127.0.0.1:8198/mcp`, stdio through `setup/mcp_stdio.py` (it reads the port from `~/Formpdf/engine.json` and starts the engine when it is not running). Every tool answers text; most also return `structuredContent`. Errors come back with `isError` and a sentence naming the next step.

## get_context

No arguments. Text lines: version, port and data folder; whether a window is open and agents are allowed; the open PDF (`id`, `key`, name, pages, current page, tab, unsaved changes, whether the last change was an agent's); PDFs agents opened without a window; up to 10 recent PDFs. Structured: `{window, agentsAllowed, outsideAgents, doc, open, recent}`; `outsideAgents` is `ask`, `allowed` or `blocked`.

## get_agent_access

No arguments. Whether outside agents may use formpdf (`outsideAgents`: `ask`, `allowed` or `blocked`) and which agents have called since formpdf started. Structured `{outsideAgents, clients}`. While access is `blocked`, every tool, this one included, is refused: tell the person it is set in Preferences, Agents, and stop.

`id` names one version of a PDF (every change makes a new id); `key` names the document across its versions. Pass either as `doc`.

## open_pdf

`{path}` absolute. A Word, PowerPoint, Excel or other Office file is first converted to `[stem].pdf` by the person's LibreOffice (get_context says whether it is installed); the original is never written. Copies the file into formpdf's working copies, adds it to recent PDFs and opens it in the window (or in the engine when no window is open). Fails when the person has unsaved changes in the window. Asks for consent. Structured `{id, key, pages, window}`.

## pdf

`{action, doc?, path?, ...}`. See `pdf-actions.md` for every action. Where it works:

- `path`: that file. Read actions read it; changing actions write `[stem]-[suffix].pdf` beside it (or `out`).
- `doc` or nothing: the open PDF (the window's, else the last one you opened). Changing actions make a new version, show it live and label it as your turn.

Changing and export actions ask for consent.

## render_pages

`{doc?, path?, pages?, width?}`. A PNG contact sheet (default 1600 px wide) of up to 12 pages, one, two, three or four columns, each labelled "Page N". Returns an image content block plus `{pages, total}`. Read-only.

## extract

`{kind: text | tables | images, doc?, path?, pages?}`. Same as `pdf` actions `text`, `tables` and `images`. Text is cut at 16,000 characters; tables come as markdown (header plus 30 rows); pictures are saved to `~/Formpdf/Media` and listed with ids and sizes.

## save

`{doc?, path?}`. Writes the open PDF's current version to `path` (absolute; `.pdf` added when missing; a folder works) or to `~/Formpdf/Exports/[name]`. The window marks the PDF as saved. Asks for consent.

## undo

`{doc?}`. With a window: undoes your last turn there (every agent change in a row with the same turn) and refuses when the last change was the person's. Without a window: steps the engine's version list back over your last turn. Asks for consent.

## answer_question

`{id, text}`. When the person chose "Your agent" as the AI provider, questions they ask in the Assistant tab wait in get_context (`Question waiting in the Assistant tab: id ...`). Read the PDF (pdf text, render_pages), then answer with `text`: cite every statement as `[p. N]` and put exact quotations in double quotes before their citation. formpdf checks each quotation against the cited page and shows the answer in the window with page links; the result says how many quotations it could not find. Structured `{id, citations, shown}`.

## extensions_list

No arguments. The Form extensions formpdf loaded (from FormPortal's `extensions/formpdf/enabled.json` and form.ext's `dev.json`): one line each with id, version, name, source (`catalogue`, `sideload`, `development`), state (`ready`, `needs-permission`, `refused` with the reason) and its command ids. Structured `{extensions: [{id, name, version, source, state, reason?, permissions, commands: [{id, title}]}]}`. Needs the window open. Read-only.

## extension_command

`{id, command, args?}`. Runs a command an extension contributes, exactly as the Extensions menu does: a command with a panel opens that panel, the others run headless and answer what the extension returned (`structuredContent.result`). The first run of an extension version shows the person formpdf's permission dialog; Not Now ends the call with an error, so tell the person and stop. An extension's changes to the PDF land as one undoable step labelled by the extension, not as your agent turn. Needs the window open. Asks for consent like other changing tools. The extension API itself is `docs/EXTENSIONS.md`.

## Resources and prompts

`formpdf://guide` is the short guide (the loop and every action). The prompt `pdf-job {path, job}` writes a starting instruction.
