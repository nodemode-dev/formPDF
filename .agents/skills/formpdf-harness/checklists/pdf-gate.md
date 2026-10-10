# PDF gate

Run before reporting.

- [ ] get_context was the first call; the right PDF was open (or every path was absolute)
- [ ] info was run first for an unknown or possibly locked PDF
- [ ] Changes went to the open PDF live (person watching) or to a new file by path (batch or unopened files), never over the original
- [ ] Before redact, find ran with the same query or preset and the person knew the count and pages
- [ ] Crop was described as hiding, redact as removing
- [ ] render_pages was looked at after the last change, for the pages that changed
- [ ] Output paths quoted exactly as the tools returned them, with page counts
- [ ] The person was told they can undo the turn and that the open PDF is not saved until they save (or save ran to the path they asked for)
