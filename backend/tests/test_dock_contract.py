import importlib
import json
import os
import stat
import threading
import time

import pytest

from _pdfs import three_pages
from conftest import INAPP_HEADER, MCP_PATH, READ_TOOL, WS_PATH, consent_refusals, set_policy, window_headers
from test_f2_consent import call, text_of

LOOPBACK = {"host": "127.0.0.1:8198"}
posix = pytest.mark.skipif(os.name == "nt", reason="stand-in programs are shell scripts")


@pytest.fixture(autouse=True)
def fresh_state():
    mcp = importlib.import_module("app.routers.mcp")
    programs = importlib.import_module("app.services.agent_programs")
    claude_code = importlib.import_module("app.services.claude_code")
    set_policy("ask")
    mcp._declined[0] = 0.0
    programs._cache["value"] = None
    claude_code._cache["value"] = None
    yield
    set_policy("ask")
    mcp._declined[0] = 0.0
    programs._cache["value"] = None
    claude_code._cache["value"] = None


def change(tmp_path):
    source = tmp_path / "letter.pdf"
    if not source.exists():
        source.write_bytes(three_pages())
    return ("pdf", {"action": "watermark", "path": str(source), "text": "DRAFT"})


def window(ws):
    ws.receive_json()
    ws.send_json({"t": "hello", "kind": "window", "name": "test window", "agents": False, "key": window_headers()["x-formpdf-window-key"]})
    ws.send_json({"t": "ping"})
    ws.receive_json()


def ask(client, tool, answer):
    box = {}
    with client.websocket_connect(WS_PATH, headers=LOOPBACK) as ws, client.websocket_connect(WS_PATH, headers=LOOPBACK) as other:
        window(other)
        window(ws)
        worker = threading.Thread(target=lambda: box.update(reply=call(client, tool)))
        worker.start()
        question = ws.receive_json()
        if answer is not None:
            ws.send_json({"t": "toolResult", "id": question["id"], "result": {"content": [], "structuredContent": answer}})
        box["gone"] = [ws.receive_json(), other.receive_json()]
        worker.join(20)
    return question, box["gone"], box["reply"]


def test_the_question_says_who_asked_what_and_how_it_can_be_answered(client, tmp_path):
    before = time.time() * 1000
    question, gone, reply = ask(client, change(tmp_path), {"allowed": True, "once": True})
    args = question["args"]
    assert question["name"] == "consent" and args["request"] == question["id"]
    assert args["agent"] == "family-test-agent"
    assert args["tool"] == "pdf" and args["what"] == "run the PDF action watermark on a file"
    assert args["answers"] == ["deny", "once", "always"] and args["alwaysCovers"] == "all"
    assert args["seconds"] == 120 and before + 119000 <= args["expiresAt"] <= time.time() * 1000 + 120000
    assert not reply["result"].get("isError"), text_of(reply)


def test_allow_once_runs_that_call_and_the_next_call_asks_again(client, tmp_path):
    config = importlib.import_module("app.core.config")
    first, gone, reply = ask(client, change(tmp_path), {"allowed": True, "once": True})
    assert not reply["result"].get("isError"), text_of(reply)
    assert (tmp_path / "letter-watermarked.pdf").exists()
    assert config.read_settings().get("outsideAgents") in (None, "ask")
    assert gone == [{"t": "consentWithdrawn", "id": first["id"], "reason": "answered", "answer": "once"}] * 2
    second, gone, reply = ask(client, change(tmp_path), {"allowed": False})
    assert second["id"] != first["id"]
    assert reply["result"].get("isError") and "did not allow" in text_of(reply)
    assert gone[0] == {"t": "consentWithdrawn", "id": second["id"], "reason": "answered", "answer": "deny"}


def test_allow_still_stores_the_choice_for_every_outside_agent(client, tmp_path):
    config = importlib.import_module("app.core.config")
    question, gone, reply = ask(client, change(tmp_path), {"allowed": True})
    assert not reply["result"].get("isError"), text_of(reply)
    assert config.read_settings().get("outsideAgents") == "allowed"
    assert gone[1] == {"t": "consentWithdrawn", "id": question["id"], "reason": "answered", "answer": "always"}


def test_a_question_nobody_answers_is_withdrawn_when_it_expires(client, tmp_path, monkeypatch):
    mcp = importlib.import_module("app.routers.mcp")
    monkeypatch.setattr(mcp, "CONSENT_SECONDS", 0.3)
    question, gone, reply = ask(client, change(tmp_path), None)
    assert reply["result"].get("isError") and "did not allow" in text_of(reply)
    assert gone == [{"t": "consentWithdrawn", "id": question["id"], "reason": "expired", "answer": None}] * 2


def test_blocked_refuses_a_call_that_carries_a_tab_token(client):
    claude_code = importlib.import_module("app.services.claude_code")
    token = claude_code.issue_env("Codex in formpdf")
    try:
        set_policy("blocked")
        reply = call(client, READ_TOOL, {INAPP_HEADER: token})
        assert reply["result"].get("isError") and consent_refusals()["blocked"] in text_of(reply)
    finally:
        claude_code.revoke(token)


def standins(tmp_path, monkeypatch, names):
    folder = tmp_path / "bin"
    folder.mkdir()
    for name in names:
        script = folder / name
        script.write_text("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"1.2.3 (" + name + ")\"; exit 0; fi\n"
                          "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\": false}'; exit 0; fi\n"
                          "{ echo \"token=${FORMPDF_INAPP_TOKEN}\"; for a in \"$@\"; do echo \"arg=$a\"; done; } > \"" + str(tmp_path) + "/$(basename \"$0\").txt\"\nread _line\n", encoding="utf-8")
        script.chmod(0o755)
    monkeypatch.setenv("PATH", str(folder) + os.pathsep + os.environ.get("PATH", ""))


@posix
def test_agent_status_names_each_program_with_its_version_and_install_line(client, bare, tmp_path, monkeypatch):
    assert bare.get("/api/agents/status").status_code == 403
    standins(tmp_path, monkeypatch, ["claude", "codex", "cursor-agent", "agy"])
    found = client.get("/api/agents/status?fresh=true", headers=window_headers()).json()
    assert sorted(found) == ["antigravity", "claude", "codex", "cursor"]
    for kind, program in found.items():
        assert program["installed"] and program["version"] == "1.2.3" and program["install"]
        assert program["path"].startswith(str(tmp_path))
        assert program["finding"] == "runs" and program["how"] == "path" and program["said"]
    assert found["claude"]["signedIn"] is False
    assert found["codex"]["signedIn"] is None and found["cursor"]["signedIn"] is None and found["antigravity"]["signedIn"] is None


@posix
@pytest.mark.parametrize("kind,program", [("codex", "codex"), ("cursor", "cursor-agent")])
def test_an_agent_tab_gets_its_own_token_outside_the_command_line_until_it_closes(client, tmp_path, monkeypatch, kind, program):
    claude_code = importlib.import_module("app.services.claude_code")
    terminal = importlib.import_module("app.services.terminal")
    monkeypatch.setenv("FORMPDF_AGENT_DIR", str(tmp_path / "work"))
    standins(tmp_path, monkeypatch, [program])
    assert client.post("/api/agents/open", json={"kind": "vim"}, headers=window_headers()).status_code == 422
    tab = client.post("/api/agents/open", json={"kind": kind, "cols": 80, "rows": 20}, headers=window_headers()).json()
    try:
        assert tab["kind"] == kind and tab["alive"]
        note = tmp_path / f"{program}.txt"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not (note.exists() and "token=" in note.read_text(encoding="utf-8")):
            time.sleep(0.1)
        lines = note.read_text(encoding="utf-8").splitlines()
        token = next(line[6:] for line in lines if line.startswith("token="))
        assert claude_code.is_inapp(token) and claude_code.label(token)
        assert token not in " ".join(terminal.get(tab["id"]).argv)
        assert not any(token in line for line in lines if line.startswith("arg="))
        if kind == "cursor":
            written = tmp_path / "work" / ".cursor" / "mcp.json"
            assert stat.S_IMODE(written.stat().st_mode) == 0o600
            assert json.loads(written.read_text(encoding="utf-8"))["mcpServers"]["formpdf_tab"]["headers"] == {INAPP_HEADER: "${env:FORMPDF_INAPP_TOKEN}"}
            assert token not in written.read_text(encoding="utf-8")
        assert client.post("/api/agents/open", json={"kind": kind}, headers=window_headers()).json()["id"] == tab["id"]
    finally:
        client.post(f"/api/terminals/{tab['id']}/close", headers=window_headers())
    assert not claude_code.is_inapp(token)


def test_a_cursor_file_the_engine_did_not_write_is_left_alone(tmp_path):
    programs = importlib.import_module("app.services.agent_programs")
    theirs = tmp_path / ".cursor" / "mcp.json"
    theirs.parent.mkdir()
    text = json.dumps({"mcpServers": {"formpdf": {"command": "python3", "args": ["setup/mcp_stdio.py"]}}})
    theirs.write_text(text, encoding="utf-8")
    assert programs.cursor_file(tmp_path) == "not written"
    assert theirs.read_text(encoding="utf-8") == text
    empty = tmp_path / "empty"
    empty.mkdir()
    assert programs.cursor_file(empty) == "file" and programs.cursor_file(empty) == "file"


@posix
def test_a_missing_program_answers_with_its_install_line(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    r = client.post("/api/agents/open", json={"kind": "codex"}, headers=window_headers())
    assert r.status_code == 404 and "npm install -g @openai/codex" in r.json()["detail"]
    assert r.json()["detail"].startswith("Codex was not found. Looked in: ")


@posix
def test_the_exit_notice_is_a_binary_frame_for_a_window_that_asks(client):
    key = window_headers()["x-formpdf-window-key"]
    term = client.post("/api/terminals", json={"cols": 80, "rows": 20}, headers=window_headers()).json()
    try:
        with client.websocket_connect(f"/api/terminal/{term['id']}", headers=LOOPBACK) as ws:
            ws.send_json({"type": "key", "key": key, "control": "binary"})
            assert json.loads(ws.receive_bytes()) == {"type": "hello", "id": term["id"], "alive": True}
            ws.send_json({"type": "input", "data": "exit\r"})
            frame = ws.receive()
            while frame.get("bytes") is None:
                assert frame.get("text") != '{"type": "exit"}'
                frame = ws.receive()
            assert json.loads(frame["bytes"]) == {"type": "exit", "id": term["id"], "alive": False}
        with client.websocket_connect(f"/api/terminal/{term['id']}", headers=LOOPBACK) as ws:
            ws.send_json({"type": "key", "key": key})
            frame = ws.receive_text()
            while frame != '{"type": "exit"}':
                frame = ws.receive_text()
    finally:
        client.post(f"/api/terminals/{term['id']}/close", headers=window_headers())


def test_the_entry_the_engine_writes_for_its_own_tabs_is_named_formpdf_tab(tmp_path):
    programs = importlib.import_module("app.services.agent_programs")
    claude_code = importlib.import_module("app.services.claude_code")
    assert [a.split("=")[0].rsplit(".", 1)[0] for a in programs.codex_args()[1::2]] == ["mcp_servers.formpdf_tab", "mcp_servers.formpdf_tab"]
    assert programs.cursor_file(tmp_path) == "file"
    assert list(json.loads((tmp_path / ".cursor" / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]) == ["formpdf_tab"]
    token, path = claude_code.issue()
    try:
        assert list(json.loads(open(path, encoding="utf-8").read())["mcpServers"]) == ["formpdf_tab"]
    finally:
        claude_code.revoke(token)
