# Workbench

## Model

`Workbench` keeps a history of states `{id, annots, label, turn?, agent?}`. Comments, field values and new form fields are staged in the window and flushed (`flush`) into a new version on Apply or Save. Every engine operation goes through `run(label, fn)` (indicator after 300 ms) and `commit(derived, label)`, which pushes a state and shows the new version in place (`show(..., keep=true)`), so Undo and Redo travel between versions.

Agent changes arrive as window tools (`live/agent.ts`): `commit` calls `agentCommit(from, id, label, turn, agent)`, which refuses when the window moved on, pushes a state carrying the turn, and shows the agent chip with Undo turn. `undoAgent` travels to the state before the first state of the newest turn, and refuses when the newest state is the person's. `state()` is reported to the engine whenever the chrome syncs.

## Panes

`panels.ts` builds every pane once and patches it: View (layouts, reading, read aloud, document, find, compare), Comment (threads with replies and status), Fill & Sign (fields, signature, stamps), Prepare form (`form.ts`), Edit (header and footer with live preview, crop, page numbers, watermark), Organize (`organize.ts`, split, merge), Extract, Protect (password, remove password, find and redact, redact areas, metadata, hidden information), Convert (PowerPoint, Word, compress, pages as PNG).

## Shell

The title bar carries the mark (Home), the menu bar (File, Edit, View, Tools, Help built from `Commands`), the document name with the Edited badge, and Undo, Redo, Open, Print, Agents, Save, Close. Menus opened over the workbench take `--z-context`. Home (`ui/home.ts`) uses the formsld Home layout; the workbench opens over it and closing returns to it.

## Layout shift rules learned here

Thumbnails in fixed slots, busy label in a fixed-width slot, agent chip fixed width, notes with minimum heights, the Remove password section disabled rather than hidden, redaction matches stale rather than cleared, compare marks cleared when page geometry changes.
