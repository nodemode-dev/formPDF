---
name: formpdf-harness
description: "Does PDF work with formpdf through its MCP server. Use whenever the person wants a PDF read, searched, compared, commented, filled, signed (by hand or with a digital ID), checked for valid signatures, prepared for signers, stamped, given form fields, reorganized, split, merged, cropped, given headers, footers, page or Bates numbers or a watermark, mined for text, tables or pictures, redacted, cleaned of hidden information, protected or unlocked, compressed, given links, attached files or measurements, given new text or pictures on the page (or its existing text retyped or restyled, or existing pictures cropped, rotated, moved, replaced or arranged), spell checked, made searchable with OCR, checked or tagged for accessibility (with alternate text and reading order), laid out for printing (pages per sheet, booklet, poster, grayscale), converted to PDF/A or PDF/X, preflighted, or converted to Word, PowerPoint, Excel, HTML or RTF, and formpdf is mentioned or its tools (get_context, open_pdf, pdf, render_pages, extract, save, undo) are available. Covers the loop, every pdf action with its arguments, live edits in the window as an undoable turn versus file jobs by path, verification by rendering, consent and handoff. Also use when a formpdf tool fails and the next step is unclear. Not for changing formpdf's own source code (use formpdf-skillset)."
license: Apache-2.0
metadata:
  author: formpdf
  version: "0.60.0"
---

# formpdf harness

formpdf is a PDF editor running on this computer: an engine on 127.0.0.1:8198 and a window the person watches. Its MCP server (`formpdf`) gives you seven tools. This pack is the method: find out what is open, do the job in as few calls as possible, look at the result, and hand it back without surprising the person.

## Doctrine

1. **The person's file is never changed in place.** Every change makes a new version. On the open PDF the window switches to it live and the person can undo your whole turn; on a file by path a new file is written beside it. Only `save` writes the open PDF to disk, and only to the path the person asked for.
2. **Look before you report.** After any change, `render_pages` the pages you touched and read the picture. A tool saying it worked does not mean the page reads well.
3. **Say what will go before it goes.** Run `pdf {action: find}` with the same query or preset before `redact`, and tell the person the count and pages. Redaction removes what is under each box for good; the rest of the page stays text. When the person wants to look first, `mark_redactions` and let them apply the marks.
4. **One job, one call.** Prefer one `pdf` call with the right arguments over many small ones. Calls less than 90 seconds apart form one turn; `undo` reverts the whole turn.
5. **Token-lean.** Ask for the pages you need (`pages: "3-5"`), use `find` instead of reading all text, render only changed pages (one sheet holds 12).

## The tools

| Tool | Use |
| --- | --- |
| `get_context` | First call: window open or not, the open PDF (id, key, name, pages, current page, unsaved changes), PDFs you opened, recent PDFs, whether agents may edit |
| `open_pdf {path}` | Put a PDF in front of the person (or in the engine when no window is open); it becomes the open PDF |
| `pdf {action, ...}` | Every PDF action; without `path` it works on the open PDF, with `path` on that file |
| `render_pages {pages}` | Contact sheet picture of up to 12 pages, labelled |
| `extract {kind}` | `text`, `tables` (markdown) or `images` (saved to the media folder) |
| `save {path}` | Write the open PDF's current version to a file |
| `undo` | Revert your last turn on the open PDF |

Full arguments and results: `references/tools.md`. Every pdf action: `references/pdf-actions.md`. Every window command, with what it does and when to use it: `references/commands.md` (written by `./formpdf agents sync`).

## The loop

1. `get_context`. If the person named a file that is not open, `open_pdf {path}` with the absolute path.
2. Unknown file: `pdf {action: info}` (pages, sizes, encryption, fields, outline).
3. Do the job with one `pdf` call. Live on the open PDF when the person is watching it; by `path` for batch jobs or files they did not open.
4. `render_pages` the changed pages; fix with another call or `undo` if wrong.
5. Hand back (see Done means).

## Live or by path

- **Live (no path):** changing actions replace the open PDF with the result in the window, labelled "Agent: [action]" in its history and status bar. The person sees it at once and can undo the turn (Edit, Undo agent turn, or Undo turn in the status bar). Nothing is on disk until save.
- **By path:** the input file is untouched; the result is `[stem]-[action].pdf` beside it, or `out`. Export actions (`split`, `to_docx`, `to_pptx`, `to_html`, `to_rtf`, `to_xlsx`) always write files: by path beside the input, live into `~/Formpdf/Exports` unless `out` is given.

## Consent

The first call that changes a PDF or writes a file asks the person in the window: Allow agents to edit? If they say Not now the tool answers that, and asks again only after 120 seconds. Do not retry in a loop; ask the person to allow it (the question in the window, Agents, or Preferences). Reading never asks. With no window open nobody can be asked, so a call that changes a PDF is refused ("The formpdf window is not open, so nobody can approve agents") unless the person already allowed agents; ask them to open formpdf and allow agents, then retry.

## When something fails

| What you see | Do |
| --- | --- |
| No formpdf tools | Ask the person to run `./formpdf agents install` and start formpdf with `./formpdf`, then restart the client |
| Connection refused | The engine is not running: ask them to run `./formpdf` (the stdio entry starts it itself) |
| "No PDF is open" | `open_pdf {path}`, or pass `path` |
| "did not allow agents" | Ask the person to allow agents, then retry once |
| "password protected" | `pdf {action: unlock, password}` on the open PDF if the person gives the password; otherwise ask them to unlock it in the window |
| "The PDF in the window changed while you worked" | The person edited meanwhile: `get_context` and redo the call |
| "unsaved changes" on open_pdf | The person must save or discard first; ask them |

## Done means

- The result was rendered and looked at after the last change.
- The person got a short summary: what changed, on which pages, where any file was written, and that they can undo your turn or save.
- Nothing was saved over their original file unless they asked for exactly that.
- `checklists/pdf-gate.md` passes.
