import pytest

from _pdfs import SECRET, every_stream, every_text, file_bytes, open_pdf, page_texts, picture_with_mask, private_letter


def _secret_box(client, doc_id):
    r = client.post(f"/api/pdf/{doc_id}/find", json={"query": SECRET})
    assert r.status_code == 200, r.text
    matches = r.json()["matches"]
    assert len(matches) == 1
    return {"page": matches[0]["page"], **matches[0]["rects"][0]}


@pytest.mark.parametrize("mode", ["content", "raster"])
def test_applied_redaction_leaves_no_trace_of_the_text(client, mode):
    doc = open_pdf(client, private_letter())
    assert SECRET in every_text(file_bytes(client, doc))
    r = client.post(f"/api/pdf/{doc}/redact", json={"areas": [_secret_box(client, doc)], "mode": mode})
    assert r.status_code == 200, r.text
    out = file_bytes(client, r.json()["id"])
    assert SECRET not in every_text(out)
    assert b"SECRET" not in every_stream(out)
    assert all(SECRET not in t for t in page_texts(client, r.json()["id"]))
    if mode == "content":
        texts = page_texts(client, r.json()["id"])
        assert "Public line stays here" in texts[0]
        assert texts[1] == "Second page"


@pytest.mark.parametrize("mode", ["content", "raster"])
def test_a_redacted_picture_leaves_neither_its_pixels_nor_its_mask(client, mode):
    data, pixels, mask = picture_with_mask()
    doc = open_pdf(client, data)
    r = client.post(f"/api/pdf/{doc}/redact", json={"areas": [{"page": 1, "x": 90, "y": 152, "w": 150, "h": 150}], "mode": mode})
    assert r.status_code == 200, r.text
    streams = every_stream(file_bytes(client, r.json()["id"]))
    assert pixels[:256] not in streams
    assert mask[:256] not in streams
    if mode == "content":
        assert "Caption stays" in page_texts(client, r.json()["id"])[0]


def test_redaction_makes_a_new_version_and_keeps_the_original(client):
    doc = open_pdf(client, private_letter())
    r = client.post(f"/api/pdf/{doc}/redact", json={"areas": [_secret_box(client, doc)]})
    assert r.json()["id"] != doc
    assert SECRET in page_texts(client, doc)[0]


def test_the_redaction_log_never_holds_the_removed_words(client):
    doc = open_pdf(client, private_letter())
    new = client.post(f"/api/pdf/{doc}/redact", json={"areas": [_secret_box(client, doc)]}).json()["id"]
    log = client.get(f"/api/pdf/{new}/redaction-log")
    assert log.status_code == 200
    assert log.json()["entries"]
    assert SECRET not in log.text and "4471" not in log.text


@pytest.mark.parametrize("areas", [[{"page": 9, "x": 0, "y": 0, "w": 50, "h": 50}], [{"x": 0, "y": 0}], "everything"])
def test_a_bad_area_is_refused_and_no_version_is_made(client, areas):
    doc = open_pdf(client, private_letter())
    r = client.post(f"/api/pdf/{doc}/redact", json={"areas": areas})
    assert r.status_code == 400, r.text
    assert SECRET in page_texts(client, doc)[0]
