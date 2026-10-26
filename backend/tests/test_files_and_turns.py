import importlib

import pytest

from _pdfs import open_pdf, three_pages


def _exports():
    return importlib.import_module("app.core.config").exports_dir()


def test_open_refuses_a_file_that_is_not_a_pdf(client):
    r = client.post("/api/pdf/open", files={"file": ("notes.txt", b"just text", "text/plain")})
    assert r.status_code == 415


@pytest.mark.parametrize("name", ["", ".bashrc", "   "])
def test_write_refuses_a_missing_or_hidden_name(client, name):
    r = client.post("/api/pdf/write", files={"file": ("x", b"data")}, data={"name": name})
    assert r.status_code in (400, 422)
    assert not (_exports() / name.strip()).is_file()


def test_write_keeps_a_named_file_inside_the_exports_folder(client):
    r = client.post("/api/pdf/write", files={"file": ("x", b"data")}, data={"name": "../../escape.txt"})
    assert r.status_code == 200, r.text
    written = r.json()["path"]
    assert written == str(_exports() / "escape.txt")
    assert (_exports() / "escape.txt").read_bytes() == b"data"


def test_write_is_refused_for_another_site(client):
    r = client.post("/api/pdf/write", files={"file": ("x", b"data")}, data={"name": "evil.sh", "path": str(_exports() / "evil.sh")},
                    headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    assert not (_exports() / "evil.sh").exists()


def test_save_needs_a_full_path_and_leaves_no_temporary_file(client, tmp_path):
    doc = open_pdf(client, three_pages())
    assert client.post(f"/api/pdf/{doc}/save", json={"path": "relative/report.pdf"}).status_code == 400
    r = client.post(f"/api/pdf/{doc}/save", json={"path": str(tmp_path / "report")})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == str(tmp_path / "report.pdf")
    assert (tmp_path / "report.pdf").read_bytes()[:5] == b"%PDF-"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["report.pdf"]


def test_calls_less_than_90_seconds_apart_are_one_turn(monkeypatch):
    mcp = importlib.import_module("app.routers.mcp")
    clock = [1000.0]
    monkeypatch.setattr(mcp.time, "monotonic", lambda: clock[0])
    agent, other = mcp.Agent("a", "one"), mcp.Agent("b", "two")
    first = mcp._turn(agent)
    clock[0] += 60
    assert mcp._turn(agent) == first
    clock[0] += 89
    assert mcp._turn(agent) == first
    assert mcp._turn(other) != first
    clock[0] += mcp.TURN_GAP + 1
    assert mcp._turn(agent) != first
