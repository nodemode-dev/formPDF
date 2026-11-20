import json
import os
import stat
import subprocess
import sys

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import BACKEND, ENGINE_PORT, REPO, WS_PATH, set_policy, window_headers

LOOPBACK = {"host": f"127.0.0.1:{ENGINE_PORT}"}
WINDOW_ONLY = [
    ("POST", "/api/settings", {"author": "Test"}),
    ("POST", "/api/ai/settings", {}),
    ("GET", "/api/terminals", None),
    ("GET", "/api/claude/status", None),
    ("GET", "/api/chat/state", None),
    ("GET", "/api/chat/sessions", None),
    ("POST", "/api/commands/catalogue", {"commands": []}),
    ("POST", "/api/plugins/none", {"allowed": False}),
    ("DELETE", "/api/trust/none", None),
    ("POST", "/api/extensions/read", {"action": "info"}),
    ("POST", "/api/window/ticket", {}),
]


@pytest.mark.parametrize("method,path,body", WINDOW_ONLY)
def test_window_only_route_refuses_without_the_key(bare, method, path, body):
    for headers in ({}, {"x-formpdf-window-key": "x" * 43}):
        r = bare.request(method, path, json=body, headers=headers)
        assert r.status_code == 403
        assert r.json()["detail"] == "Only the formpdf window can do this"


@pytest.mark.parametrize("method,path,body", WINDOW_ONLY)
def test_window_only_route_works_with_the_key(client, method, path, body):
    assert client.request(method, path, json=body, headers=window_headers()).status_code != 403


def test_bootstrap_answers_once_then_refuses(client, monkeypatch):
    from app.core import window_key

    monkeypatch.setitem(window_key.STATE, "claimed", False)
    monkeypatch.setitem(window_key.STATE, "secondClaim", False)
    first = client.post("/api/window/key")
    assert first.status_code == 200 and first.json()["key"] == window_key.KEY
    assert client.post("/api/window/key").status_code == 409
    assert client.get("/api/settings").json()["secondWindowClaim"] is True


def test_bootstrap_does_not_exist_when_the_shell_reads_the_key(client, monkeypatch):
    from app.core import window_key

    monkeypatch.setenv(window_key.STDOUT_ENV, "1")
    monkeypatch.setitem(window_key.STATE, "claimed", False)
    assert client.post("/api/window/key").status_code == 404


def test_event_stream_needs_a_ticket_that_works_once(client):
    assert client.get("/api/events").status_code == 403
    from app.core import window_key

    ticket = window_key.ticket()
    assert window_key.spend(ticket)
    assert client.get(f"/api/events?ticket={ticket}").status_code == 403


def test_live_client_without_the_key_is_not_a_window(client):
    from app.services import bridge

    with client.websocket_connect(WS_PATH, headers=LOOPBACK) as ws:
        ws.receive_json()
        ws.send_json({"t": "hello", "kind": "window", "name": "probe", "agents": True})
        ws.send_json({"t": "ping"})
        ws.receive_json()
        assert not bridge.window_connected()
        assert not any(c.agents for c in bridge.windows())
        ws.send_json({"t": "hello", "kind": "window", "name": "probe", "agents": True, "key": window_headers()["x-formpdf-window-key"]})
        ws.send_json({"t": "ping"})
        ws.receive_json()
        assert bridge.window_connected()


def test_terminal_socket_without_the_key_is_closed(client):
    term = client.post("/api/terminals", json={"cols": 80, "rows": 20}, headers=window_headers()).json()
    try:
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect(f"/api/terminal/{term['id']}", headers=LOOPBACK) as ws:
                ws.send_json({"type": "input", "data": "true\r"})
                ws.receive_text()
        assert refused.value.code == 4403
        with client.websocket_connect(f"/api/terminal/{term['id']}", headers=LOOPBACK) as ws:
            ws.send_json({"type": "key", "key": window_headers()["x-formpdf-window-key"]})
            ws.send_json({"type": "input", "data": "echo key-ok\r"})
            seen = ""
            while "key-ok" not in seen:
                seen += ws.receive_text()
    finally:
        client.post(f"/api/terminals/{term['id']}/close", headers=window_headers())


def test_inapp_token_lives_in_a_private_file_until_revoked():
    from app.services import claude_code

    token, path = claude_code.issue()
    assert claude_code.is_inapp(token)
    if os.name != "nt":
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert json.loads(open(path, encoding="utf-8").read())["mcpServers"]["formpdf_tab"]["headers"]["x-formpdf-inapp"] == token
    claude_code.revoke(token)
    assert not os.path.exists(path)
    assert not claude_code.is_inapp(token)


def test_engine_prints_the_key_line_once_before_its_address(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("FORMPDF_")}
    env.update(FORMPDF_DATA_DIR=str(tmp_path), FORMPDF_PORT="0", FORMPDF_WINDOW_KEY_STDOUT="1")
    proc = subprocess.Popen([sys.executable, "formpdf_engine.py"], cwd=BACKEND, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    try:
        while not any("http://127.0.0.1:" in line for line in lines):
            line = proc.stdout.readline()
            assert line, "\n".join(lines)
            lines.append(line)
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    keyed = [i for i, line in enumerate(lines) if line.startswith("formpdf-window-key: ")]
    assert len(keyed) == 1
    assert keyed[0] < len(lines) - 1
    assert len(lines[keyed[0]].split(": ", 1)[1].strip()) >= 32


def test_command_line_under_ask_refuses_and_keeps_the_choice(tmp_path):
    from reportlab.pdfgen import canvas

    pdf = tmp_path / "mail.pdf"
    c = canvas.Canvas(str(pdf))
    c.drawString(72, 720, "Write to ann@example.com today.")
    c.save()
    (tmp_path / "settings.json").write_text(json.dumps({"outsideAgents": "ask"}), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("FORMPDF_")}
    env.update(FORMPDF_DATA_DIR=str(tmp_path), PYTHONPATH=str(BACKEND))
    out = subprocess.run([sys.executable, "setup/cli.py", "redact", str(pdf), "--preset", "email"], cwd=REPO, env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 1
    assert "nobody can approve agents" in out.stdout + out.stderr
    assert json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))["outsideAgents"] == "ask"
    assert not (tmp_path / "mail-redact.pdf").exists()
    set_policy("ask")
