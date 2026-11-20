import re

import pytest

READS = {"GET", "HEAD", "OPTIONS"}
OPEN = {("POST", "/mcp"), ("DELETE", "/mcp"), ("POST", "/api/window/key")}


def write_operations(app):
    return [(m.upper(), path) for path, item in app.openapi()["paths"].items() for m in item if m.upper() not in READS]


def test_the_open_list_is_short_and_named():
    from app.core import window_key

    assert set(window_key.OPEN) == {"/mcp", "/api/window/key"}


def test_every_write_route_needs_the_window_key(app, bare):
    ops = write_operations(app)
    assert len(ops) > 40
    answered = []
    for method, path in ops:
        if (method, path) in OPEN:
            continue
        url = re.sub(r"\{[^}]+\}", "x", path)
        for headers in ({}, {"x-formpdf-window-key": "x" * 43}):
            r = bare.request(method, url, json={}, headers=headers)
            if r.status_code != 403 or r.json() != {"detail": "Only the formpdf window can do this"}:
                answered.append(f"{method} {path} {r.status_code}")
    assert not answered, "write routes that answer without the window key (add the key, or name the route in window_key.OPEN with its caller): " + ", ".join(answered)


@pytest.mark.parametrize("path", ["/api/ai/test", "/api/ai/ask", "/api/pdf/open-path", "/api/batch/run"])
def test_named_write_routes_refuse_without_the_key(bare, path):
    assert bare.post(path, json={}).status_code == 403


def test_open_routes_still_answer_without_the_key(bare):
    r = bare.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}}, headers={"mcp-protocol-version": "2025-11-25"})
    assert r.status_code == 200
