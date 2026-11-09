#!/usr/bin/env python3
"""Copies the three browser demos' documents into the app build, so Home > Demos and Help > Demos open them in the window.

The demos in demo/ (pages and search), demos/sign (annotate, fill and sign) and demos/protect (redact, compare, convert)
carry their PDFs as JavaScript data packs (base64, for file://). This decodes the pack each demo opens first into a
plain PDF under frontend/public/demos/<demo>/, which Vite copies into frontend/dist and the desktop app serves from
there. For the sign demo it also writes marks.json, the text anchors its pack carries for the comments the demo starts
with. Every file is one the demo folders' CREDITS.md lists; nothing else is copied. Run from anywhere:

    python3 scripts/demo-media.py
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "public" / "demos"
PACKS = {
    "pages": ("demo/assets/media/alice.js", "alice", "alice-in-wonderland.pdf"),
    "sign": ("demos/sign/assets/media/loan-form.js", "loan-form", "telescope-loan-agreement.pdf"),
    "protect": ("demos/protect/assets/media/report-final.js", "report-final", "season-report-final.pdf"),
}


def decode(text: str, pack_id: str) -> bytes:
    m = re.search(r"\[['\"]" + re.escape(pack_id) + r"['\"]\]\s*=\s*['\"]([A-Za-z0-9+/=]+)['\"]", text)
    if not m:
        raise SystemExit(f"{pack_id}: no data in the pack")
    data = base64.b64decode(m.group(1))
    if not data.startswith(b"%PDF-"):
        raise SystemExit(f"{pack_id}: the pack does not hold a PDF")
    return data


def anchors(text: str, pack_id: str) -> dict | None:
    m = re.search(r"__formpdfMeta\[['\"]" + re.escape(pack_id) + r"['\"]\]\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    return json.loads(m.group(1)).get("anchors") if m else None


def main() -> None:
    for demo, (src, pack_id, name) in PACKS.items():
        text = (ROOT / src).read_text()
        folder = OUT / demo
        folder.mkdir(parents=True, exist_ok=True)
        pdf = decode(text, pack_id)
        (folder / name).write_bytes(pdf)
        print(f"{demo}/{name}: {len(pdf)} bytes")
        found = anchors(text, pack_id)
        if found:
            (folder / "marks.json").write_text(json.dumps({"anchors": found}, separators=(",", ":")) + "\n")
            print(f"{demo}/marks.json: {len(found)} anchors")


if __name__ == "__main__":
    main()
