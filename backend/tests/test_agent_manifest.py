import importlib
import json
import sys

from conftest import REPO


def sync_module():
    sys.path.insert(0, str(REPO / "setup"))
    try:
        return importlib.import_module("agents")
    finally:
        sys.path.remove(str(REPO / "setup"))


def committed():
    return json.loads((REPO / "agents" / "manifest.json").read_text(encoding="utf-8"))


def test_committed_manifest_is_what_sync_writes():
    assert sync_module().manifest_drift() is False


def test_manifest_lists_the_tools_the_server_lists():
    mcp = importlib.import_module("app.routers.mcp")
    listed = committed()["mcp"]
    assert listed["tools"] == [t["name"] for t in mcp.TOOLS]
    assert listed["read_only"] == [t["name"] for t in mcp.TOOLS if t["annotations"]["readOnlyHint"]]
    assert set(listed["read_only"]) <= set(listed["tools"])
    assert set(listed["approval_gated"]) <= set(listed["tools"])
    assert not set(listed["read_only"]) & set(listed["approval_gated"])


def test_every_gated_name_is_a_tool_and_no_other_tool_can_wait_for_approval():
    mcp = importlib.import_module("app.routers.mcp")
    named = set(mcp.GATED) | set(mcp.GATED_BY_ARGUMENTS)
    assert named <= mcp.NAMES
    for name in mcp.NAMES - named:
        for args in ({}, {"action": "redact"}, {"id": "file.save"}, {"save": True}, {"steps": [{"id": "file.save"}]}):
            assert mcp._mutating(name, args) is False


def test_manifest_names_the_skills_and_the_host_api():
    manifest = committed()
    assert [s["name"] for s in manifest["skills"]] == sorted(p.name for p in (REPO / ".claude" / "skills").iterdir() if (p / "SKILL.md").is_file())
    assert manifest["extensions"] == {"host_api": importlib.import_module("app.services.formext_host").API}
    assert manifest["app"] == "formpdf"
