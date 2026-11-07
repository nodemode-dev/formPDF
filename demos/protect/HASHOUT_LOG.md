# Hashout log: demo 3

- Real modules reused, nothing redrawn: Viewer, Thumbs, Comparer, ComparePanel, openDocument, icons, dom helpers and the app stylesheets. Find marks use the app's own opaque black style.
- Redaction rasterises marked pages at 2.4x with boxes painted black, removes Contents, Annots, Thumb, PieceInfo and AA, then garbage-collects the object graph so the original content is not left orphaned in the file. Invisible text is re-added for the unredacted words so the page stays searchable.
- Text geometry is measured with canvas and the bundled Liberation fonts; one family is chosen per run by closest width, and runs are squeezed to the measured width.
- The flat page image is tagged so Extract skips it after a redaction.
- Compare is a word-level LCS per page producing the app's CompareResult, so the real panel draws it.
- Password protection is written by hand: AES-256 revision 6 with Web Crypto. The proof list opens the output in pdf.js with and without the password.
- Convert builds the docx zip by hand (stored, CRC32). Tables are detected only with two or more aligned rows.
- Vite: IIFE output with a classic-script HTML post-step so file:// works; assets inlined; pdf.js worker becomes a blob URL through a virtual module; the viewer asset glob is narrowed.
- Media ships as base64 script packs rather than fetched files, since fetch is blocked on file://.
