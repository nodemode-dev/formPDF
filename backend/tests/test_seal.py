import json

import pytest

from conftest import set_policy, window_headers


class MemoryKeyring:
    priority = 1

    def __init__(self):
        self.items = {}

    def get_password(self, service, username):
        return self.items.get((service, username))

    def set_password(self, service, username, password):
        self.items[(service, username)] = password

    def delete_password(self, service, username):
        self.items.pop((service, username), None)


@pytest.fixture
def keychain(monkeypatch):
    import keyring
    from keyring.backend import KeyringBackend

    from app.core import seal

    backend = type("Standin", (MemoryKeyring, KeyringBackend), {})()
    previous = keyring.get_keyring()
    keyring.set_keyring(backend)
    seal.reset()
    yield backend
    keyring.set_keyring(previous)
    seal.reset()
    set_policy("ask")


def _stored():
    from app.core import config

    return json.loads(config.settings_path().read_text(encoding="utf-8"))


def _hand_edit(**values):
    from app.core import config

    data = _stored()
    data.update(values)
    config.settings_path().write_text(json.dumps(data), encoding="utf-8")


def test_a_window_write_is_sealed_and_stands(client, keychain):
    r = client.post("/api/settings", json={"outsideAgents": "allowed"}, headers=window_headers())
    assert r.status_code == 200
    assert r.json()["seal"] == "ok"
    assert _stored()["seal"]
    s = client.get("/api/settings").json()
    assert s["outsideAgents"] == "allowed" and not s["sealBroken"]


def test_a_hand_edit_to_allowed_is_caught(client, keychain):
    client.post("/api/settings", json={"outsideAgents": "ask"}, headers=window_headers())
    _hand_edit(outsideAgents="allowed", agentsAllowed=True, claudeBin="/tmp/other-claude")
    s = client.get("/api/settings").json()
    assert s["outsideAgents"] == "ask"
    assert s["claudeBin"] == ""
    assert s["sealBroken"] is True
    from app.routers import mcp

    assert mcp.access() == "ask"


def test_a_hand_edit_keeps_blocked_blocked(client, keychain):
    client.post("/api/settings", json={"outsideAgents": "blocked"}, headers=window_headers())
    _hand_edit(claudeBin="/tmp/other-claude")
    s = client.get("/api/settings").json()
    assert s["outsideAgents"] == "blocked" and s["sealBroken"] is True


def test_an_unrelated_write_does_not_bless_a_hand_edit(client, keychain):
    client.post("/api/settings", json={"outsideAgents": "ask"}, headers=window_headers())
    _hand_edit(outsideAgents="allowed")
    client.post("/api/settings", json={"author": "Someone"}, headers=window_headers())
    assert client.get("/api/settings").json()["sealBroken"] is True


def test_no_keychain_leaves_the_stored_choice_and_reports_unavailable(client, monkeypatch):
    import keyring
    from keyring.backends import fail

    from app.core import seal

    previous = keyring.get_keyring()
    keyring.set_keyring(fail.Keyring())
    seal.reset()
    try:
        set_policy("allowed")
        s = client.get("/api/settings").json()
        assert s["seal"] == "unavailable"
        assert s["outsideAgents"] == "allowed"
        assert client.post("/api/settings", json={"outsideAgents": "ask"}, headers=window_headers()).status_code == 200
    finally:
        keyring.set_keyring(previous)
        seal.reset()
        set_policy("ask")


def test_keyring_that_will_not_import_degrades(client, monkeypatch):
    import builtins

    from app.core import seal

    real = builtins.__import__

    def refuse(name, *args, **kwargs):
        if name == "keyring":
            raise ImportError("left out of this build")
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", refuse)
    seal.reset()
    try:
        assert client.get("/api/settings").json()["seal"] == "unavailable"
    finally:
        monkeypatch.undo()
        seal.reset()
