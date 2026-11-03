# Contributing to FormPDF

Thank you for helping. FormPDF aims to be a free PDF editor that runs on your own
computer, where an agent can do PDF work in the open window while you watch, and it
gets there through real use and real contributions.

## Where to start

- **Use it and report what goes wrong.** A clear bug report, with steps, the version
  and your platform, is one of the most useful things you can give.
- **Look at the open issues.** Comment on one before starting larger work, so nobody
  builds the same thing twice. [docs/PARITY.md](docs/PARITY.md) lists the capability
  rows FormPDF is built against, and the README's Known gaps says what is still missing.
- **Translations** are welcome: FormPDF ships in English and 23 other languages, one
  table each in `frontend/src/ui/i18n`. `python3 setup/i18n.py parity` shows what each
  table is missing.

## Setting up

Clone the repository and run `./formpdf install`, then `./formpdf` (or
`formpdf.bat install` and `formpdf.bat` on Windows). The first installs the engine's
venv and the interface packages; the second starts the engine on 127.0.0.1:8198 and the
app on http://localhost:5198. You need Python 3.12+ and Node 20.19+ or 22.12+, and
`./formpdf doctor` checks them; the README's Install and run has the details.

The code lives in:

| Folder | What is there |
| --- | --- |
| `backend` | the engine (Python, FastAPI): PDF services, `/api/pdf`, the live channel, the MCP server |
| `frontend/src` | the interface (TypeScript, Vite): Home, the PDF workbench, the ui toolkit |
| `src-tauri` | the desktop shell (Rust, Tauri) and the engine sidecar |
| `setup` | install, boot, build, serve, freeze, desktop, agents and command line scripts |
| `backend/tests`, `frontend/tests/window` | the test suites |
| `docs` | the manual and the capability checklist |

## Before you open a pull request

Run the same checks CI runs:

```sh
(cd frontend && npm ci && npm audit && npm run build)
(cd backend && pip install -r requirements.txt && python -m compileall -q app formpdf_engine.py && python formpdf_engine.py --selfcheck)
pip install -r backend/requirements.txt -r backend/requirements-test.txt
(cd backend && python -m pytest tests -q -p no:cacheprovider)
pip install pytest playwright && python -m playwright install chromium
python -m pytest frontend/tests/window -q -p no:cacheprovider
```

CI also boots the engine and probes `/api/health` and `/api/version`, checks the shell
scripts with `bash -n`, and refuses an em dash in tracked Markdown or an emoji in any
tracked text.

- Keep each pull request to one change, with tests for what it adds or fixes.
- Write commit subjects the way the history does, in Conventional Commits:
  `feat(scope): ...`, `fix(scope): ...`, `docs(...)`, with a body. Leave the version
  alone; a maintainer bumps it when releasing.
- Every window action is a command in `frontend/src/ui/commands.ts`, so agents and the
  command line get it too. Add new actions as commands.
- A changed English string is changed in place in all 23 tables in
  `frontend/src/ui/i18n`, in FormPDF's own words; `python3 setup/i18n.py parity` must
  not get worse.
- Icons are inline `currentColor` SVG in `frontend/src/ui/icons.ts`, and z-index comes only
  from `frontend/src/styles/tokens.css`.
- Licences stay permissive: no PyMuPDF, pdf2docx or ghostscript, and no GPL or AGPL.
  Every new dependency, font or data file gets a row in `NOTICE.md`.
- Other vendors' product names appear only to describe a format or compatibility.
  Never copy vendor help text, stamps, icons or sample files.
- Some find-to-redact behaviours were declined for patent risk and will not come back:
  a see-through or hatched look for ticked matches before Apply (marks from the find
  list draw opaque black), any hover, tooltip or overlay on the page that shows the
  text under a find mark (the list shows it instead), and a pre-redaction view that
  keeps the selected match readable.

## Maintainers

FormPDF is maintained by:

- the [nodemode-dev](https://github.com/nodemode-dev) organisation on GitHub
- [@nodemode-ai](https://github.com/nodemode-ai)
- [@gbarnai](https://github.com/gbarnai)

Reach them through issues and pull requests.

## How changes land

Only a maintainer pushes to `main`. Everyone else forks the repository and opens a pull request into `main`. A pull request merges when all five checks pass on an up-to-date branch and a maintainer has approved it after its last push.

## Releases

A release is a version, and only a maintainer makes one: after the version is bumped on
`main`, a maintainer cuts a `compile_vX.Y.Z` branch, and formcompiler
(`nodemode-dev/formcompiler`) builds every platform and publishes them together. No push
from a contributor starts a release. The README's Desktop section has the details.

## Licensing

FormPDF is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). By contributing,
you agree that your contribution is licensed under the same terms. Only add code you
have the right to contribute, and name any third-party code and its licence in the pull
request.

## Patents and other people's IP

A feature may be held back or removed if it would infringe someone else's patent or
other intellectual property. The maintainers decide.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Security
problems go through [SECURITY.md](SECURITY.md), never a public issue.
