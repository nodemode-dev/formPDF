# Apply formpdf changes in InDesign

`apply-formpdf-changes.jsx` applies a formpdf change list to the InDesign document the PDF was made from. Reviewers strike out, replace and insert text and add notes in formpdf (or in Acrobat, then import the comments into formpdf); Comment > Share comments > Export text changes saves the list as JSON.

## Install

1. In InDesign, open Window > Utilities > Scripts.
2. Right-click User and choose Reveal in Finder (Explorer on Windows).
3. Copy `apply-formpdf-changes.jsx` into that folder.

## Use

1. Open the InDesign document.
2. Double-click Apply formpdf changes in the Scripts panel and choose the change list.
3. Say whether to record the edits with Track Changes. With it on, each edit can be accepted or rejected in the Story Editor.

The whole run is one step in Edit > Undo. A report named after the change list (`changes.applied.txt` for `changes.json`) lists each change with its outcome.

## How changes are found

Each change carries its text and up to 40 characters before and after it. The script compares them with every story while leaving out spaces, line breaks and hyphens, so text that has reflowed or was hyphenated at a line end in the PDF still matches. When the same text occurs more than once, the occurrence whose surrounding words match best wins; the page the change was made on breaks a tie.

| Change | In InDesign |
|---|---|
| delete | The text is removed, with one space next to it so no double space is left |
| replace | The text becomes the replacement, keeping the formatting of its first character |
| insert | The text goes in where the caret was |
| comment | An InDesign note at the end of the text, with the author and replies |

Changes whose status is rejected, cancelled or completed are skipped; unreviewed and accepted ones are applied.

## Outcomes in the report

- applied
- not found: the text is not in any story. Text in running headers, master pages and the pasteboard is drawn on the PDF page but may not be in a story the script can edit, and text in tables and footnotes is not searched.
- ambiguous: the text occurs more than once and nothing tells the occurrences apart. Make that change by hand.
- overlaps another change: two changes touch the same text; the first one in the list is applied.
- skipped: the status said not to apply it.

## Limits

The matching was tested outside InDesign, on change lists formpdf exported from reviewed PDFs. The InDesign part uses the scripting interface from InDesign CS4 onward (stories, insertion points, notes, track changes) and has not been run inside InDesign for this release.
