# formpdf window commands

Generated from the window's command catalogue (139 commands) by `./formpdf agents sync`; do not edit by hand. The live list is the MCP tool `list_commands` (and `describe_command` for one); run one with `run_command`, or from a shell with `./formpdf cli run <id> key=value`. Changes (marked below) go through the person's consent like every other change.

## Contents

- Accessibility: 3
- Comment: 3
- Edit: 12
- File: 8
- Forms: 8
- Help: 4
- Home: 13
- Print: 6
- Tabs: 12
- Tools: 36
- View: 14
- Workspace: 20

## Accessibility

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `tool-access-alt-draft` | Draft alternate text with AI | Drafts alternate text for figures with the AI provider, for the person to review and save. | Use to get draft alternate text for figures from the person's AI provider; the drafts wait in Accessibility > Alternate text for the person to review and save. |
| `tool-access-claim-ua` | Claim PDF/UA-1 | Marks the PDF as meeting PDF/UA-1 after embedding its fonts; refused while the accessibility check still fails. Changes the PDF. | Use after the accessibility check passes, to mark the file as meeting PDF/UA-1; formpdf embeds the fonts and refuses while any rule of its own check still fails. |
| `tool-access-verapdf` | Check PDF/UA with veraPDF | Validates the PDF against PDF/UA-1 with veraPDF, when it is installed. | Use to get the reference validator's PDF/UA-1 verdict; it needs veraPDF installed on the computer. |

### tool-access-alt-draft parameters

- `ids`: array; figure ids; every figure without alternate text when left out

## Comment

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `tool-carry-comments` | Carry comments from the reviewed version… | Moves a reviewed PDF's comments onto this new version of it, each to where its words now are. Changes the PDF. | Use when this PDF is a new version of a reviewed one (exported again from the layout app) and the reviewer's comments should move onto it, following their words; give from, the reviewed PDF's path, or leave it out to ask the person for the file. |
| `tool-changes-export` | Export text changes (JSON) | Saves the text changes and notes on text as a JSON list for a layout app. | Use to hand struck-out, replaced and inserted text to a layout app as a JSON change list with the surrounding words. |
| `tool-xfdf-import` | Import comments (XFDF)… | Brings a reviewer's comments and their status from XFDF into this PDF, without duplicates. Changes the PDF. | Use to bring a reviewer's comments and their status (accepted, completed, rejected) back into this PDF; give the XFDF text as data, or leave it out to ask the person for a file. |

### tool-carry-comments parameters

- `from`: string; path of the reviewed PDF; a file picker opens when left out

### tool-xfdf-import parameters

- `data`: string; the XFDF file text; a file picker opens when left out
- `pages`: string; only comments on these pages, such as 2-5

## Edit

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `pdf-find` | Find… | Opens Find to search the text of the document. | Use to look for words in the PDF. |
| `pdf-redo` | Redo | Repeats a change that was undone. Changes the PDF. | Use after an undo that went too far. |
| `pdf-undo` | Undo | Steps back one change. Changes the PDF. | Use to reverse the last change. |
| `pdf-undo-agent` | Undo agent turn | Undoes everything the last agent turn changed, as one step. Changes the PDF. Asks first. | Use when an agent turn should be reversed as a whole. |
| `tool-fonts` | Fonts in this PDF… | Lists the fonts in the PDF, whether they are embedded and installed, and which family edits them. | Use to see which fonts are embedded, subset, standard or installed before editing or printing. |
| `tool-grow-story` | Continue story on new pages | Adds pages with a copy of the last frame until an overflowing story fits. Changes the PDF. | Use when a text box overflows and the rest of its story should continue on new pages. |
| `tool-move-to-page` | Move to page… | Moves the selected added text boxes and pictures to another page, keeping their position. Changes the PDF. | Use when selected added text boxes or pictures belong on another page; they keep their position on the page. |
| `tool-shape-group` | Group shapes | Groups the selected shapes so they select, move and resize as one; the group is saved in the PDF. Changes the PDF. | Use when several shapes on one page make one thing, such as a logo, and should select and move as one; Ctrl+G. |
| `tool-shape-spot` | Spot colour for selected shapes… | Colours the selected shapes with a named spot ink (a Separation colour space). Changes the PDF. | Use when selected shapes must print in a named ink such as a Pantone colour; cmyk is how it looks on screen and in proofs. |
| `tool-shape-ungroup` | Ungroup shapes | Takes the selected shapes out of their groups. Changes the PDF. | Use when the shapes of a group should select one by one again; Ctrl+Shift+G. |
| `tool-thread-text` | Thread text boxes | Links the selected added text boxes so one story flows through them in order. Changes the PDF. | Use when two selected text boxes should hold one story that flows from the first into the second. |
| `tool-unthread-text` | Unthread text box | Takes a text box out of its story thread. Changes the PDF. | Use when a text box should hold its own text again. |

### tool-move-to-page parameters

- `page`: integer from 1; the page to move the selection to; without it the window asks

### tool-shape-spot parameters

- `name`: string; required; the ink name exactly as the printer knows it, such as PANTONE 300 C
- `cmyk`: array; required; [c, m, y, k] in percent for the screen and proofs
- `tint`: number 0 to 1; how much of the ink, default 1
- `line`: boolean; colour the line instead of the fill

## File

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `pdf-close` | Close PDF | Closes the document in the window. Asks first. | Use when the work on this PDF is finished. |
| `pdf-create-files` | Combine files into a PDF… | Combines PDFs, pictures and Office files into one new PDF. | Use when several files of different kinds should become a single PDF. |
| `pdf-create-pictures` | Create PDF from pictures… | Makes a new PDF with one page per picture. | Use when the person has photos or scans as picture files and wants one PDF. |
| `pdf-home` | Home | Goes back to the Home screen; unsaved changes stay in the version history. Asks first. | Use to leave the document and pick another task. |
| `pdf-open` | Open a PDF… | Opens a PDF from this computer in the window. | Use to start work on a PDF the person names or picks. |
| `pdf-print` | Print… | Opens the print dialog for the document. | Use when the person wants to print on a printer. |
| `pdf-save` | Save | Saves the document over the file it came from. Changes the PDF. Asks first. | Use when the person asks to save; agents normally leave saving to the person. |
| `pdf-scan` | Scan… | Scans pages from a network scanner into a PDF. | Use when the person wants to scan paper into formpdf. |

## Forms

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `form-align-bottom` | Align bottom edges (form fields) | Lines up the selected form fields on their bottom edges. Changes the PDF. | Use while laying out a form. |
| `form-align-center` | Align centres (form fields) | Lines up the selected form fields on their centres. Changes the PDF. | Use while laying out a form. |
| `form-align-distH` | Distribute across (form fields) | Spaces the selected form fields evenly across. Changes the PDF. | Use while laying out a row of fields. |
| `form-align-distV` | Distribute down (form fields) | Spaces the selected form fields evenly down. Changes the PDF. | Use while laying out a column of fields. |
| `form-align-left` | Align left edges (form fields) | Lines up the selected form fields on their left edges. Changes the PDF. | Use while laying out a form. |
| `form-align-middle` | Align middles (form fields) | Lines up the selected form fields on their middles. Changes the PDF. | Use while laying out a form. |
| `form-align-right` | Align right edges (form fields) | Lines up the selected form fields on their right edges. Changes the PDF. | Use while laying out a form. |
| `form-align-top` | Align top edges (form fields) | Lines up the selected form fields on their top edges. Changes the PDF. | Use while laying out a form. |

## Help

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `pdf-agents` | Agents and MCP… | Shows how to connect Claude Code, Codex or Cursor to formpdf. | Use when the person wants an agent to work in formpdf. |
| `pdf-help` | formpdf Help | Opens formpdf Help. | Use when the person asks how something works. |
| `pdf-preferences` | Preferences… | Opens Preferences: language, AI provider, spelling and more. | Use to change formpdf settings. |
| `pdf-shortcuts` | Keyboard shortcuts | Lists the keyboard shortcuts. | Use when the person asks for shortcuts. |

## Home

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `home-agents` | Agents and MCP… | Shows how to connect Claude Code, Codex or Cursor to formpdf. | Use when the person wants an agent to work in formpdf. |
| `home-batch` | Batch: run an action on many PDFs | Runs one action or action list on many PDFs, writing new files. | Use when the same change is needed on a folder of PDFs. |
| `home-help` | formpdf Help | Opens formpdf Help. | Use when the person asks how something works. |
| `home-merge` | Merge PDFs… | Combines several PDFs into one. | Use to join PDFs. |
| `home-office` | Create PDF from Office files… | Converts Word, Excel and PowerPoint files to PDF. | Use when the person has Office files to turn into PDF. |
| `home-open` | Open a PDF… | Opens a PDF from this computer. | Use from Home to start on a PDF. |
| `home-path` | Open a PDF by path… | Opens a PDF by typing its path. | Use when the path is known. |
| `home-pictures` | Create PDF from pictures… | Makes a new PDF with one page per picture. | Use when the person has picture files to combine. |
| `home-prefs` | Preferences… | Opens Preferences. | Use to change formpdf settings. |
| `home-recent` | Recent PDFs | Shows the PDFs opened recently. | Use to return to recent work. |
| `home-reviews` | Reviews: comments across your PDFs | Lists open comments across your PDFs. | Use to follow up reviews in several documents. |
| `home-scan` | Scan… | Scans pages from a network scanner into a PDF. | Use to scan paper. |
| `home-shortcuts` | Keyboard shortcuts | Lists the keyboard shortcuts. | Use when the person asks for shortcuts. |

## Print

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `tool-add-bleed` | Add bleed… | Adds bleed around the trim box, growing the page without moving anything on it. Changes the PDF. | Use when artwork must run past the trimmed edge of the printed page; give the bleed in millimetres. |
| `tool-output-preview` | Preview separations… | Shows the page with chosen inks (process or spot) turned off. | Use to see a page without some inks, for example only the spot colour plate or without black; give the inks to hide, or none to show all. |
| `tool-pdf20` | Save as PDF 2.0 | Rewrites the PDF as PDF 2.0 with its information in XMP metadata. Changes the PDF. | Use when a workflow asks for PDF 2.0. |
| `tool-pdfvt` | Make PDF/VT… | Turns a PDF/X-4 file into PDF/VT with one document part per record, optionally divided into sections. Changes the PDF. | Use on a PDF/X-4 file of many personalised records (letters, cards) so a press can treat each record separately; give pages_per_record, or by: bookmarks for one record per top-level bookmark; divide each record into sections (a letter, then its invoice) with section_pages or sections: bookmarks. |
| `tool-pdfx-check` | Check PDF/X… | Checks the PDF against PDF/X-1a, X-3, X-4, X-6 or PDF/VT by formpdf's own checks. | Use before sending a file to a press, to see whether it meets PDF/X-1a, X-3, X-4, X-6 or PDF/VT and what is missing. |
| `tool-verapdf` | Validate with veraPDF… | Validates the PDF against PDF/A or PDF/UA with veraPDF, the reference validator, when it is installed. | Use to get the reference validator's verdict on PDF/A or PDF/UA after formpdf's own check or conversion; it needs veraPDF installed on the computer, and lists each failed rule with its clause. |

### tool-add-bleed parameters

- `mm`: number 0 to 50; bleed in millimetres, default 3
- `pages`: string; pages such as 1-4; all pages when left out

### tool-output-preview parameters

- `hide`: array; ink names to turn off: Cyan, Magenta, Yellow, Black or a spot colour name; empty shows every ink

### tool-pdfvt parameters

- `pages_per_record`: integer from 1; pages in every record
- `by`: string (pages | bookmarks); bookmarks: one record per top-level bookmark
- `section_pages`: array; pages in each section of every record, in order, such as [1, 2]; they add up to the record length
- `sections`: string (bookmarks); bookmarks: one section per bookmark directly under the record's bookmark

### tool-pdfx-check parameters

- `level`: string (X-1a | X-3 | X-4 | X-6 | VT); the standard to check against; the one the file claims when left out

### tool-verapdf parameters

- `flavour`: string (1a | 1b | 2a | 2b | 2u | 3a | 3b | 3u | ua1 | ua2); the standard to check against; the one the file claims when left out

## Tabs

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `pdf-tab-access` | Accessibility | Opens the Accessibility tab: checks, tags, reading order and alternate text. | Use to make the PDF work with screen readers. |
| `pdf-tab-assistant` | Assistant | Opens the Assistant tab: ask, summarise and generate with the AI provider. | Use for AI help with this PDF. |
| `pdf-tab-comment` | Comment | Opens the Comment tab: highlights, notes, shapes, stamps and the review round-trip. | Use to review or mark up the PDF. |
| `pdf-tab-convert` | Convert | Opens the Convert tab: Word, PowerPoint, HTML, pictures and text recognition. | Use to turn the PDF into another format or make a scan searchable. |
| `pdf-tab-edit` | Edit | Opens the Edit tab: page text, pictures, shapes, links, headers and footers. | Use to change the content of pages. |
| `pdf-tab-extract` | Extract | Opens the Extract tab: text, pictures and tables out of the PDF. | Use to take content out of the document. |
| `pdf-tab-fill` | Fill & Sign | Opens the Fill & Sign tab: form fields, signatures and initials. | Use to fill in a form or sign. |
| `pdf-tab-form` | Prepare form | Opens the Prepare form tab: add and arrange form fields. | Use to turn a PDF into a fillable form. |
| `pdf-tab-organize` | Organize | Opens the Organize tab: move, turn, insert, delete and split pages. | Use to change the pages themselves. |
| `pdf-tab-print` | Print | Opens the Print tab: preflight, PDF/A, PDF/X, PDF/VT, page boxes and separations. | Use to prepare a PDF for a printer, a press or an archive. |
| `pdf-tab-protect` | Protect | Opens the Protect tab: passwords, redaction, metadata and hidden information. | Use before sharing a PDF that holds private information. |
| `pdf-tab-view` | View | Opens the View tab: layout, zoom, reading aloud and properties. | Use to change how the document is shown. |

## Tools

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `tool-access-alt` | Add alternate text to figures | Opens alternate text for the figures. | Use to describe pictures for screen reader users. |
| `tool-access-check` | Check accessibility | Checks the PDF against accessibility rules and lists what fails. | Use before publishing a PDF that must be accessible. |
| `tool-access-report` | Save accessibility report | Saves the accessibility check as a report. | Use when someone needs the results in a file. |
| `tool-access-tag` | Tag for accessibility | Adds tags (headings, paragraphs, lists, tables, figures) so screen readers can follow the PDF. Changes the PDF. | Use on an untagged PDF before fixing accessibility. |
| `tool-add-picture` | Add a picture to the page… | Places a picture file on the page. | Use to add a logo, photo or graphic. |
| `tool-add-text` | Add page text | Adds a new text box to the page. | Use to write new text on a page. |
| `tool-ai-ask` | Ask this PDF (AI) | Asks the AI provider a question about this PDF, with page citations. | Use when the person has a question the document answers. |
| `tool-ai-deck` | Generate a presentation (AI) | Drafts a presentation from this PDF with the AI provider. | Use to turn a document into slides. |
| `tool-ai-picture` | Generate a picture (AI) | Generates a picture from a description and places it on the page. Changes the PDF. | Use when the person wants an illustration made. |
| `tool-ai-summary` | Summarise this PDF (AI) | Summarises the PDF with the AI provider. | Use for a quick overview of a long document. |
| `tool-attach` | Attach files… | Attaches files to the PDF. Changes the PDF. | Use to carry source files or data inside the PDF. |
| `tool-attach-pin` | Pin a file to the page… | Pins a file to a spot on the page as an attachment comment. | Use when an attached file belongs to a place on a page. |
| `tool-back` | Send to back | Sends the selected objects behind everything. Changes the PDF. | Use to put an object behind the rest of the page. |
| `tool-backward` | Send backward | Sends the selected objects one step back. Changes the PDF. | Use to fine-tune the stacking order. |
| `tool-certsign` | Sign with a digital ID | Signs the PDF with a digital ID (a certificate signature). Changes the PDF. Asks first. | Use when the person wants a signature others can verify; it is theirs to place. |
| `tool-content-select` | Select text and pictures | Selects page text, pictures and shapes to move, resize and edit. | Use to change what is already on a page. |
| `tool-export-html` | Save as HTML | Saves the PDF as a web page. | Use to publish the content on the web. |
| `tool-export-rtf` | Save as RTF | Saves the text of the PDF as RTF. | Use when the text should open in any word processor. |
| `tool-export-xlsx` | Save as Excel | Saves the tables in the PDF as an Excel workbook. | Use to work with table data in a spreadsheet. |
| `tool-forward` | Bring forward | Brings the selected objects one step forward. Changes the PDF. | Use to fine-tune the stacking order. |
| `tool-front` | Bring to front | Brings the selected objects in front of everything. Changes the PDF. | Use when an object is hidden behind another. |
| `tool-link-auto` | Link web and email addresses | Turns every web and email address in the text into a link. Changes the PDF. | Use when addresses in the PDF should be clickable. |
| `tool-link-draw` | Draw a link… | Draws a link area on the page that goes to a page or a web address. | Use to add a clickable link. |
| `tool-lists` | Action lists… | Opens the action lists: saved steps to run on this PDF or many. | Use to repeat the same steps on documents. |
| `tool-lists-record` | Record an action list | Records the changes you make as a new action list. | Use to capture steps once and run them again later. |
| `tool-measure-area` | Measure area | Measures the area of a shape you click out. | Use on drawings and plans. |
| `tool-measure-distance` | Measure distance | Measures the distance between two points at the document scale. | Use on drawings and plans. |
| `tool-measure-perimeter` | Measure perimeter | Measures the length around a shape you click out. | Use on drawings and plans. |
| `tool-ocr` | Make searchable (OCR) | Recognises the text on scanned pages so it can be searched and copied. Changes the PDF. | Use on scans and photos of documents. |
| `tool-pdfa` | Convert to PDF/A | Converts the PDF to PDF/A for long-term archiving. Changes the PDF. | Use when an archive or authority asks for PDF/A. |
| `tool-print-booklet` | Print a booklet… | Prints pages as a folded booklet. | Use to print a booklet on a home or office printer. |
| `tool-print-save` | Save a print PDF | Saves the print layout (booklet, n-up, tiles) as a new PDF. | Use to send a ready-to-print layout to someone else. |
| `tool-sig-new-id` | New digital ID… | Makes a new self-signed digital ID on this computer. | Use when the person has no digital ID yet. |
| `tool-sigrequest` | Request signatures | Prepares the PDF for several people to sign in turn. | Use when others must sign after the person. |
| `tool-spell` | Check spelling | Checks the spelling of the page text. | Use before sending a document. |
| `tool-xfdf-export` | Export comments (XFDF) | Saves the comments as an XFDF file for another reviewer or app. | Use to send comments without the PDF. |

## View

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `pdf-compare` | Compare with another PDF… | Compares the open PDF with another and highlights what changed. | Use to see the differences between two versions of a document. |
| `pdf-cover` | Show cover page in two-page view | Puts the first page on its own in two-page view. | Use when the first page is a cover, so the spreads pair up as printed. |
| `pdf-fit-page` | Fit page | Zooms so a whole page fits in the window. | Use to see a page at a glance. |
| `pdf-fit-width` | Fit width | Zooms so a page fills the width of the window. | Use for reading text comfortably. |
| `pdf-go-page` | Go to page… | Scrolls to a page by number. | Use when the person or a task needs a specific page shown in the window. |
| `pdf-layout-continuous` | Single page continuous | Shows pages one under another, scrolling continuously. | Use for normal reading and editing; it is the default. |
| `pdf-layout-single` | Single page | Shows one page at a time. | Use for reading page by page. |
| `pdf-layout-two` | Two-page | Shows two pages side by side, a spread at a time. | Use to see facing pages of a book or brochure. |
| `pdf-layout-two-continuous` | Two-page continuous | Shows spreads of two pages, scrolling continuously. | Use to scroll through facing pages. |
| `pdf-reading` | Reading mode | Hides the toolbars and panels to read the document. | Use when the person only wants to read. |
| `pdf-rotate` | Rotate view | Turns the view a quarter turn; the PDF is not changed. | Use when a page is sideways on screen; to turn pages in the file use Organize. |
| `pdf-zoom-in` | Zoom in | Makes the pages larger. | Use to look closer. |
| `pdf-zoom-out` | Zoom out | Makes the pages smaller. | Use to see more of the document at once. |
| `tool-show-boxes` | Show trim and bleed on the page | Draws the trim, bleed and art boxes on the pages. | Use to see where a printed page will be cut. |

### pdf-go-page parameters

- `page`: integer from 1; 1-based page number; without it the page box is focused

## Workspace

| Id | Name | Does | Use when |
| --- | --- | --- | --- |
| `ws-access` | Accessibility workspace | Switches to a workspace for accessibility work. | Use while tagging and checking accessibility. |
| `ws-all` | All tools workspace | Switches to the workspace with every tab and panel. | Use for general work. |
| `ws-delete` | Delete this workspace | Deletes the current custom workspace. Asks first. | Use when the person no longer wants a saved workspace. |
| `ws-forms` | Forms workspace | Switches to a workspace for building and filling forms. | Use while working on form fields. |
| `ws-labels` | Labels on toolbar buttons | Shows labels next to the toolbar icons. | Use when the icons alone are unclear. |
| `ws-notes` | Comments under the page list | Shows comments under the page list. | Use to keep comments in view while working. |
| `ws-panel` | Panel | Shows or hides the tool panel. | Use to make room for the pages or to see the tools. |
| `ws-panel-bottom` | Bottom | Docks the tool panel under the pages. | Use on a wide screen to keep the pages tall. |
| `ws-panel-float` | Floating | Lets the tool panel float over the pages. | Use to place the panel anywhere. |
| `ws-panel-left` | Left | Docks the tool panel on the left. | Use to move the tool panel to the left side. |
| `ws-panel-right` | Right | Docks the tool panel on the right. | Use to move the tool panel to the right side. |
| `ws-prepress` | Prepress workspace | Switches to a workspace for print production: preflight, boxes and separations. | Use when preparing a file for a press. |
| `ws-read` | Read workspace | Switches to a workspace for reading, with the pages large. | Use when the person is reading, not editing. |
| `ws-reset` | Reset this workspace | Puts the current workspace back as it was saved. | Use after moving panels around by accident. |
| `ws-review` | Review workspace | Switches to a workspace for reviewing, with comments beside the pages. | Use during a review. |
| `ws-save` | Save workspace as… | Saves the current arrangement of panels as a named workspace. | Use when the person wants to keep a layout. |
| `ws-side` | Page list | Shows or hides the page list. | Use to make room for the pages or to see thumbnails. |
| `ws-side-left` | Left | Puts the page list on the left. | Use to move the page list to the left side. |
| `ws-side-right` | Right | Puts the page list on the right. | Use to move the page list to the right side. |
| `ws-use` | Switch workspace… | Switches to a workspace by name. | Use to arrange the window for a task: All tools, Read, Review, Prepress, Forms, Accessibility or a saved workspace. |

### ws-save parameters

- `name`: string; name for the new workspace; asked for when left out

### ws-use parameters

- `name`: string; required; workspace name
