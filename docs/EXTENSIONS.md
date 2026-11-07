# formpdf extensions

formpdf loads extensions that follow the Form Extension Contract, API 1 (product id `formpdf`). An extension is a folder (or a `.formpkg` that FormPortal unpacks) with a `manifest.json` and a web page. formpdf shows that page in a sandboxed frame (`sandbox="allow-scripts"`, nothing else) and talks to it only through `postMessage` JSON-RPC, so an extension can do only what this page lists, and only after the person allows it.

These are separate from formpdf's own folder plug-ins (Preferences > Plugins), which run unsandboxed code from `~/Formpdf/plugins` and keep working as before.

## The host

| Item | formpdf |
| --- | --- |
| `host.hello` | `{ product: "formpdf", app: "formpdf", appVersion: "0.59.0", api: "1", extension: { id, version, source }, permissions, theme, locale }` |
| Theme tokens | `--bg`, `--panel`, `--text`, `--muted`, `--accent`, `--border`, `--radius`, plus formpdf's own `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--border-color`, `--accent-color`. `mode` is `light` for the light themes. `ext.theme` is sent whenever the person changes the theme or accent. |
| Storage | `storage.get` and `storage.set`, 256 KB per extension, kept in the window. |
| `files.open` | Yes: the window's own file picker (any extension list in `accept`). At most 200 MB in total. |
| `files.save` | Yes: the save dialog (desktop app) or the browser's save picker. Where neither exists, formpdf asks you to confirm the name in its own dialog and saves into the Downloads folder (the browser adds a number when the name is taken). Cancel answers -32002. |
| `net.fetch` | No: formpdf does not reach the network for documents, so it answers -32003. |
| `ui.notify` | formpdf's toasts (`error` shows as an error toast, the other levels as a normal one). |
| `ui.resize` | Sets the height of a docked panel (up to 4000 px). |

## document.read

`document.read { what? }` needs the `document` permission. Without a PDF open, `what: "summary"` returns `{ "open": false }` and the other values fail with -32004.

| `what` | Returns |
| --- | --- |
| `summary` (default) | the open PDF: id, key, name, path, pages, current page, tab, unsaved changes, and its properties |
| `text` | `{ pages: [{ page, text }] }`; pass `pages` ("3", "1-4", "2,5", "4-") to read fewer |
| `fields` | `{ fields: [{ name, type, page, x, y, w, h, value, readonly, required, options? }] }` |
| `comments` | `{ comments: [{ page, index, nm, kind, label, text, author, date, color, rect, replies, status }] }` |
| `selection` | `{ page, tab, pages }`: the page the person is looking at and the tab they are on |
| `file` | `{ name, type: "application/pdf", size, data }` with `data` base64 (at most 200 MB): the open PDF's current version, with every change the person or an extension has applied. Comments, field values and page moves still waiting for Apply are not in it until they are applied. |

A real `summary`, from formpdf 0.59.0 with a three-page PDF open:

```json
{
  "open": true,
  "id": "pdf_bgwnjva0yf",
  "key": "pdf_bgwnjva0yf",
  "name": "sample.pdf",
  "path": "/home/me/Documents/sample.pdf",
  "pages": 3,
  "page": 1,
  "tab": "view",
  "dirty": false,
  "info": {
    "bytes": 2343,
    "encrypted": false,
    "locked": false,
    "title": "untitled",
    "author": "anonymous",
    "subject": "unspecified",
    "keywords": "",
    "creator": "anonymous",
    "producer": "ReportLab PDF Library - (opensource)",
    "created": "2026-11-07T00:15:04+00:00",
    "modified": "2026-11-07T00:15:04+00:00",
    "pages": 3,
    "sizes": [{ "w": 595.276, "h": 841.89, "rotate": 0 }, { "w": 595.276, "h": 841.89, "rotate": 0 }, { "w": 595.276, "h": 841.89, "rotate": 0 }],
    "outline": [],
    "fields": 0,
    "signed": false,
    "version": "1.3"
  }
}
```

`id` names one version of the PDF; every change makes a new id, while `key` stays the same for the document. Coordinates are PDF points from the top left of the page as shown.

## document.apply

`document.apply { label, ops: [{ command, args }] }` needs `document`. Each `command` is one of formpdf's change actions, with the same arguments as the `pdf` tool of formpdf's MCP server (the formpdf://guide resource lists them all). The ops run in order, each on the result of the one before, and the result lands in the window as one change, labelled `label`, that one Undo takes back. Comments, field values and page moves the person has not applied yet are applied first. The answer is `{ applied, results: [{ command, detail }], id, pages }`. If any op fails, nothing changes and the call fails with -32004 and formpdf's own message.

The most useful change actions:

| `command` | `args` |
| --- | --- |
| `page_numbers` | `position` (bottom-center, bottom-right, bottom-left, top-center, top-right, top-left), `format` ("{n}", "Page {n} of {total}"), `start`, `size`, `color`, `pages` |
| `header_footer` | `header` and `footer` as `{ left, center, right }` with tokens `<<page>>` `<<pages>>` `<<date>>` `<<file>>` `<<bates>>`, `size`, `color`, `font` (sans, serif, mono), `margins`, `start`, `apply` (all, odd, even), `bates` `{ prefix, suffix, start, digits }`, `pages` |
| `watermark` | `text`, `opacity` (0 to 1), `angle`, `size`, `color`, `pages` |
| `annotate` | `annotations: [{ kind, page, ... }]` (highlight, underline, strikeout, note, freetext, ink, rect, ellipse, line, arrow, stamp), or `highlight: "a phrase"` with `color`; `flatten` |
| `fill` | `values: { field name: value }`, `flatten` |
| `form` | `create: [{ type, page, x, y, w, h, name, ... }]`, `rename: { old: new }`, `delete: [names]` |
| `organize` | `order: [page numbers]`, `delete: [pages]`, `rotate` (90, 180, 270) with `pages`, `blank: [after page]` |
| `crop` | `margins: { l, t, r, b }`, `box: { x, y, w, h }` or `auto: true`, `pages` |
| `redact` | `areas: [{ page, x, y, w, h }]`, or `query` or `preset` (email, phone, card, date) to redact every match; `color`, `overlay` |
| `metadata` | `title`, `author`, `subject`, `keywords`, `strip` |
| `edit_outline` | bookmarks to add, rename, move and delete |
| `edit_items` | `add`, `update`, `remove`: text and pictures on the page |
| `compress` | `quality` (10 to 95) |
| `sanitize` | `remove: [metadata, javascript, attachments, comments, fields, layers, links, bookmarks, thumbnails, private, hidden_text]` |
| `ocr` | make scanned pages searchable (`pages`, `dpi`, `skip`, `deskew`) |

`merge`, `protect`, `unlock` and the export actions (Word, PowerPoint, split and the rest) are not available to extensions: they need paths or passwords, or write files. `files.save` writes what an extension makes.

## app.commands and app.run

`app.commands {}` needs `document` and lists `[{ id, title, args?, kind }]`: every window command formpdf's menus, palette and shortcuts use (`kind: "window"`, `args` their parameters), then every engine action (`kind: "read"` or `"change"`).

`app.run { command, args }` needs `document` and runs one of them:

- a window command runs exactly as if the person chose it, and answers what it returned;
- a read action answers `{ text, data }` (for example `find { query }`, `links`, `items { pages }`, `blocks`, `hidden`, `fields`, `comments`, `info`);
- a change action runs as its own undoable step, as `document.apply` with one op.

Useful window commands:

| `command` | `args` | Does |
| --- | --- | --- |
| `pdf-go-page` | `{ page }` | shows that page |
| `pdf-zoom-in`, `pdf-zoom-out`, `pdf-fit-width`, `pdf-fit-page` | | zoom |
| `pdf-layout-single`, `pdf-layout-continuous`, `pdf-layout-two`, `pdf-layout-two-continuous` | | page display |
| `pdf-reading` | | reading mode on or off |
| `pdf-find` | | opens Find in document |
| `pdf-tab-view`, `pdf-tab-comment`, `pdf-tab-fill`, `pdf-tab-form`, `pdf-tab-edit`, `pdf-tab-organize`, `pdf-tab-extract`, `pdf-tab-protect`, `pdf-tab-convert`, `pdf-tab-access`, `pdf-tab-print` | | switches the tab |
| `pdf-undo`, `pdf-redo` | | undo and redo |
| `pdf-save` | | saves the PDF |

The full list, with each command's parameters, is `app.commands`, or `./formpdf` with the window open and the MCP tool `list_commands`.

## Events

`ext.event { name, data }` is sent to every open extension frame:

| `name` | `data` | When |
| --- | --- | --- |
| `document.changed` | the `summary` above, or `{ open: false }` | a PDF opens or closes, any change (the person's, an agent's or an extension's), undo and redo, save |
| `selection.changed` | `{ page, tab, pages }` | the person moves to another page or tab |

## Where extensions appear

- **Extensions menu**, in the workbench menu bar between Tools and Window: one item per contributed command (`Name: Title`), then Extensions Panel, Reload Extensions and Manage in FormPortal (opens `formai://extensions?product=formpdf`). On macOS with menus in the menu bar it is a menu there too.
- **Extensions tab**: the last tab in the workbench. Its panel is the Extensions panel (each extension's name, version, source, permission chips, state and Open); each docked panel an extension opens joins it as a section of the same tab, chosen from the chips at the top of the panel and titled with the extension's name.
- **Dialogs**: a panel with `location: "dialog"` opens as a formpdf dialog titled with the extension's name.
- **Find a command or tool** (Mod+K) lists every contributed command and Extensions Panel and Reload Extensions.
- **Agents**: the MCP tools `extensions_list` and `extension_command { id, command, args }` (the window must be open; the consent rules are the same as in the window).

## Running an extension

- **From a folder (development):** form.ext's Run in App writes `extensions/formpdf/dev.json` under FormPortal's folder; you can also write it yourself:

  ```json
  { "format": "formext-dev-extensions", "format_version": 1, "product": "formpdf", "extensions": [ { "id": "my-extension", "path": "/home/me/my-extension", "added": "2026-11-07T10:00:00Z" } ] }
  ```

  formpdf notices the change within 2 seconds while its window has focus (or on Extensions > Reload Extensions) and lists the extension as Development, with its folder path. Edit the files and choose Reload Extensions, or close and reopen the panel, to load them again.
- **minimum_app:** a source build of formpdf reports its last release until the release commit, so leave `minimum_app` out of a test copy (or set it to that release) when you test against an unreleased build; otherwise the extension is refused with "it needs formpdf 0.59.0 or newer".
- **From FormPortal:** FormPortal installs a `.formpkg`, unpacks it and writes `extensions/formpdf/enabled.json`; formpdf picks it up the same way, as Catalogue or File.

FormPortal's folder is `FORMPORTAL_ROOT` when set; otherwise `~/Library/Application Support/studio.formai.portal` on macOS, `%LOCALAPPDATA%\FormPortal` on Windows and `$XDG_DATA_HOME/formportal` (or `~/.local/share/formportal`) on Linux.

## Consent

The first time an extension version opens a panel or runs a command, formpdf asks in its own dialog, before it creates the extension's frame, listing what the extension asks for in plain words. Allow is remembered for that id, version and set of permissions; a new version, or one that asks for more, asks again. Not Now is not remembered: nothing opens, the row stays at Needs Permission, and the next activation asks again.

## Files the engine serves

`GET /api/extensions` lists the extensions with a `stamp` (the modification times of `enabled.json` and `dev.json`), and `GET` (or `HEAD`) `/api/extensions/files/{id}/{version}/{path}` serves an extension's own files with the contract's headers (`nosniff`, `no-store`, CORS `*`, and the content security policy on HTML). Anything outside the folder, any symbolic link and any file type the contract does not list answers 404.
