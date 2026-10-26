import io

from pypdf import PdfReader

from _pdfs import SECRET, every_stream, file_bytes, form, open_pdf, page_texts, private_letter, three_pages


def test_a_filled_and_flattened_form_keeps_its_value_as_page_content(client):
    doc = open_pdf(client, form())
    assert [f["name"] for f in client.get(f"/api/pdf/{doc}/fields").json()["fields"]] == ["fullname"]
    r = client.post(f"/api/pdf/{doc}/fields", json={"values": {"fullname": "Ada Lovelace"}, "flatten": True})
    assert r.status_code == 200, r.text
    new = r.json()["id"]
    assert client.get(f"/api/pdf/{new}/fields").json()["fields"] == []
    assert "Ada Lovelace" in page_texts(client, new)[0]
    assert "/AcroForm" not in PdfReader(io.BytesIO(file_bytes(client, new))).trailer["/Root"] or not PdfReader(io.BytesIO(file_bytes(client, new))).get_fields()


def test_a_filled_form_left_live_reads_back_its_value(client):
    doc = open_pdf(client, form())
    new = client.post(f"/api/pdf/{doc}/fields", json={"values": {"fullname": "Grace Hopper"}}).json()["id"]
    fields = {f["name"]: f["value"] for f in client.get(f"/api/pdf/{new}/fields").json()["fields"]}
    assert fields == {"fullname": "Grace Hopper"}


def test_merge_keeps_every_page_in_order(client):
    a, b = open_pdf(client, three_pages()), open_pdf(client, private_letter())
    r = client.post("/api/pdf/merge", json={"ids": [a, b]})
    assert r.status_code == 200, r.text
    texts = page_texts(client, r.json()["id"])
    assert len(texts) == 5
    assert [t.split("\n")[0] for t in texts] == ["Page one", "Page two", "Page three", "Public line stays here", "Second page"]
    assert client.post("/api/pdf/merge", json={"ids": [a]}).status_code == 400


def test_split_makes_one_document_per_range(client):
    doc = open_pdf(client, three_pages())
    r = client.post(f"/api/pdf/{doc}/split", json={"ranges": ["1-2", "3"]})
    assert r.status_code == 200, r.text
    parts = r.json()["parts"]
    assert [p["pages"] for p in parts] == [2, 1]
    assert page_texts(client, parts[0]["id"]) == ["Page one", "Page two"]
    assert page_texts(client, parts[1]["id"]) == ["Page three"]


def test_organize_reorders_rotates_and_deletes(client):
    doc = open_pdf(client, three_pages())
    r = client.post(f"/api/pdf/{doc}/organize", json={"pages": [{"page": 3}, {"page": 1, "rotate": 90}]})
    assert r.status_code == 200, r.text
    new = r.json()["id"]
    assert page_texts(client, new) == ["Page three", "Page one"]
    reader = PdfReader(io.BytesIO(file_bytes(client, new)))
    assert [p.rotation % 360 for p in reader.pages] == [0, 90]
    assert b"Page two" not in every_stream(file_bytes(client, new))


def test_a_deleted_page_leaves_nothing_of_itself_in_the_file(client):
    doc = open_pdf(client, private_letter())
    r = client.post(f"/api/pdf/{doc}/organize", json={"pages": [{"page": 2}]})
    assert r.status_code == 200, r.text
    out = file_bytes(client, r.json()["id"])
    assert page_texts(client, r.json()["id"]) == ["Second page"]
    assert b"SECRET" not in every_stream(out)


def test_page_numbers_land_on_every_page(client):
    doc = open_pdf(client, three_pages())
    r = client.post(f"/api/pdf/{doc}/page-numbers", json={"format": "Page {n} of {total}"})
    assert r.status_code == 200, r.text
    texts = page_texts(client, r.json()["id"])
    for n, text in enumerate(texts, start=1):
        assert f"Page {n} of 3" in text
    assert client.post(f"/api/pdf/{doc}/page-numbers", json={"format": "no number"}).status_code == 400


def test_a_watermark_is_on_each_page_and_the_text_stays(client):
    doc = open_pdf(client, three_pages())
    r = client.post(f"/api/pdf/{doc}/watermark", json={"text": "DRAFT COPY"})
    assert r.status_code == 200, r.text
    texts = page_texts(client, r.json()["id"])
    assert len(texts) == 3
    assert all("DRAFT COPY" in t for t in texts)
    assert ["Page one" in texts[0], "Page two" in texts[1], "Page three" in texts[2]] == [True, True, True]
    assert client.post(f"/api/pdf/{doc}/watermark", json={"text": "  "}).status_code == 400
