import pytest

from _pdfs import file_bytes, open_pdf, private_letter

PASSWORD = "test-id-password"


@pytest.fixture(scope="module")
def identity(client):
    r = client.post("/api/identities", json={"name": "Test Signer", "password": PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _sign(client, doc, identity, password=PASSWORD):
    return client.post(f"/api/pdf/{doc}/act/sign", json={"identity": identity, "password": password, "box": {"page": 1, "x": 72, "y": 600, "w": 160, "h": 48}})


def _verdicts(client, doc):
    r = client.post(f"/api/pdf/{doc}/act/signatures", json={})
    assert r.status_code == 200, r.text
    return r.json()["signatures"]


def test_a_signed_document_verifies(client, identity):
    doc = open_pdf(client, private_letter())
    r = _sign(client, doc, identity)
    assert r.status_code == 200, r.text
    sigs = _verdicts(client, r.json()["id"])
    assert len(sigs) == 1
    assert sigs[0]["verdict"] == "valid"
    assert sigs[0]["coversAll"] is True
    assert sigs[0]["signer"]["name"] == "Test Signer"


def test_one_changed_byte_makes_the_signature_invalid(client, identity):
    signed = _sign(client, open_pdf(client, private_letter()), identity).json()["id"]
    data = bytearray(file_bytes(client, signed))
    at = data.find(b"Helvetica")
    assert at > 0
    data[at] = ord("h")
    sigs = _verdicts(client, open_pdf(client, bytes(data), "changed.pdf"))
    assert sigs[0]["verdict"] == "invalid"
    assert "changed after it was signed" in " ".join(sigs[0]["says"])


def test_a_wrong_id_password_signs_nothing(client, identity):
    doc = open_pdf(client, private_letter())
    r = _sign(client, doc, identity, password="not-the-password")
    assert r.status_code == 400
    assert "password" in r.json()["detail"]
    assert _verdicts(client, doc) == []


def test_an_unknown_identity_is_refused(client):
    doc = open_pdf(client, private_letter())
    for ident in ("0123456789", "../../etc/x", ""):
        assert _sign(client, doc, ident).status_code == 400
