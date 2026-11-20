import asyncio

import pytest

from conftest import set_policy


@pytest.fixture
def mail_pdf(tmp_path):
    from reportlab.pdfgen import canvas

    path = tmp_path / "mail.pdf"
    c = canvas.Canvas(str(path))
    c.setAuthor("ann@example.com")
    c.setKeywords("contact bob@example.org")
    c.drawString(72, 720, "Write to ann@example.com or bob@example.org about the lease.")
    c.showPage()
    c.drawString(72, 720, "Billing: carol@example.net. Support: dave@example.co.uk.")
    c.save()
    set_policy("allowed")
    yield path
    set_policy("ask")


def _run(args):
    from app.routers import mcp

    res = asyncio.run(mcp.call_tool(mcp.Agent("test-honest", "test"), "pdf", args))
    assert not res.get("isError"), res
    return res["content"][0]["text"], res.get("structuredContent") or {}


def test_find_reports_matches_outside_the_pages(client, mail_pdf):
    text, data = _run({"action": "find", "path": str(mail_pdf), "preset": "email"})
    assert text.startswith("4 matches on 2 pages; also 2 in metadata (Author, Keywords)")
    assert data["elsewhere"] == [{"place": "metadata", "count": 2, "fields": ["Author", "Keywords"]}]


def test_redact_lists_only_what_it_removed_and_what_is_left(client, mail_pdf):
    text, _ = _run({"action": "redact", "path": str(mail_pdf), "preset": "email"})
    assert "pictures" not in text and "shapes" not in text and "comments or fields" not in text
    assert "glyphs" in text
    assert text.rstrip(").").endswith("page content clean, 2 left in metadata (Author, Keywords), run sanitize")


def test_sanitize_reports_what_it_found(client, mail_pdf):
    redacted = mail_pdf.with_name("mail-redacted.pdf")
    _run({"action": "redact", "path": str(mail_pdf), "preset": "email", "out": str(redacted)})
    text, data = _run({"action": "sanitize", "path": str(redacted), "out": str(mail_pdf.with_name("clean.pdf"))})
    assert "found and removed metadata (" in text
    assert "javascript" not in text and "thumbnails" not in text
    assert list(data["found"]) == ["metadata"]
    again, _ = _run({"action": "sanitize", "path": str(mail_pdf.with_name("clean.pdf")), "out": str(mail_pdf.with_name("again.pdf"))})
    assert "found nothing to remove" in again
    after, data = _run({"action": "find", "path": str(mail_pdf.with_name("clean.pdf")), "preset": "email"})
    assert after.startswith("0 matches") and not data["elsewhere"]
