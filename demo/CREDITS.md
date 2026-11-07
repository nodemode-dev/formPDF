# demo CREDITS

Every document the demo opens by default. Each is shipped as a base64 JS data pack in `assets/media/` so it works from file://; the PDF inside the pack is the file named below. Licences are as stated on the source page that was opened and read for that file.

| File in the demo | Title | Author | Source page | Licence as stated | What was changed |
|---|---|---|---|---|---|
| `alice-in-wonderland.pdf` (pack `alice.js`) | Alice's Adventures in Wonderland, Storyland Series edition, 1916 | Lewis Carroll (text); Gordon Robinson (illustrator of the colour plates, with the line drawings of the same edition) | https://www.gutenberg.org/ebooks/19033 | "Public domain in the USA." | The text of the edition was set again as a new 53 page PDF (6 by 9 inch pages, Liberation Serif and Inter, both SIL OFL 1.1, from `backend/app/fonts`) with a cover, title page, contents with links, outline, running heads, page numbers and the four colour plates. Straight quotes became typographic quotes. The scans of the edition (4 colour plates, one of them reused on the cover, and the line drawings) are embedded unchanged at their original size and are not upscaled. The Project Gutenberg header, licence text and trademark are not included in the PDF. |
| `apollo11-mission-summary.pdf` (pack `apollo-summary.js`) | Apollo 11 Mission Report (NASA SP-238), Summary and Mission Description | NASA Manned Spacecraft Center, Mission Evaluation Team | https://ntrs.nasa.gov/citations/19710015566 | "Work of the US Gov. Public Use Permitted." | Pages 13 to 24 of the 230 page report copied into a new PDF, document title set. The cover page with the agency logo was left out. |
| `apollo11-lunar-surface-photos.pdf` (pack `apollo-surface.js`) | Apollo 11 Mission Report (NASA SP-238), Lunar Surface Photographs | NASA Manned Spacecraft Center, Mission Evaluation Team | https://ntrs.nasa.gov/citations/19710015566 | "Work of the US Gov. Public Use Permitted." | Pages 148 to 159 of the same report copied into a new PDF, document title set. |

NASA's own statement on reuse of its material is at https://www.nasa.gov/nasa-brand-center/images-and-media/ ("generally are not subject to copyright in the United States"). NASA is acknowledged as the source of the two report excerpts. Their text layer is the report's own character recognition, so words can run together when searched.

The demo also loads the pdf.js JBIG2 decoder (`jbig2.wasm`, row in `NOTICE.md`) so the scanned NASA figures draw.
