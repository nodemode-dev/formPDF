import io

from pypdf import PdfReader

from _pdfs import file_bytes, open_pdf, with_bookmark, with_hidden_things


def _counts(client, doc_id):
    return {i["key"]: i["count"] for i in client.get(f"/api/pdf/{doc_id}/hidden").json()["items"]}


def test_sanitize_removes_metadata_javascript_and_attachments(client):
    doc = open_pdf(client, with_hidden_things())
    before = _counts(client, doc)
    assert before["metadata"] and before["javascript"] and before["attachments"]
    r = client.post(f"/api/pdf/{doc}/sanitize", json={"remove": ["metadata", "javascript", "attachments"]})
    assert r.status_code == 200, r.text
    out = file_bytes(client, r.json()["id"])
    after = _counts(client, r.json()["id"])
    assert (after["metadata"], after["javascript"], after["attachments"]) == (0, 0, 0)
    reader = PdfReader(io.BytesIO(out))
    assert not reader.metadata or not any(reader.metadata.values())
    assert "/Metadata" not in reader.trailer["/Root"]
    assert not dict(reader.attachments)
    raw = out.decode("latin-1")
    for word in ("app.alert", "Jane Example", "Secret plan", "private notes", "/JavaScript", "/EmbeddedFiles"):
        assert word not in raw, word


def test_sanitize_removes_only_what_was_ticked(client):
    doc = open_pdf(client, with_hidden_things())
    r = client.post(f"/api/pdf/{doc}/sanitize", json={"remove": ["javascript"]})
    after = _counts(client, r.json()["id"])
    assert after["javascript"] == 0
    assert after["attachments"] == 1
    assert dict(PdfReader(io.BytesIO(file_bytes(client, r.json()["id"]))).attachments)


def test_removed_bookmarks_leave_no_titles_behind(client):
    doc = open_pdf(client, with_bookmark())
    assert b"Private chapter title" in file_bytes(client, doc)
    r = client.post(f"/api/pdf/{doc}/sanitize", json={"remove": ["bookmarks"]})
    assert r.status_code == 200, r.text
    out = file_bytes(client, r.json()["id"])
    assert b"Private chapter title" not in out and b"Private section title" not in out
    assert len(PdfReader(io.BytesIO(out)).pages) == 3


def test_sanitize_with_nothing_ticked_is_refused(client):
    doc = open_pdf(client, with_hidden_things())
    for remove in ([], ["nonsense"]):
        assert client.post(f"/api/pdf/{doc}/sanitize", json={"remove": remove}).status_code == 400
