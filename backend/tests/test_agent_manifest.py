import hashlib
import importlib
import json
import re
import shutil
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


def test_the_shared_dock_folder_is_what_its_manifest_says():
    sync = sync_module()
    assert sync.dock_drift() == []
    assert sync.dock_strangers() == []
    assert json.loads((sync.DOCK_DIR / "MANIFEST.json").read_text(encoding="utf-8"))["version"] == "2.1.0"


def test_an_edited_added_or_app_importing_dock_file_is_named(tmp_path, monkeypatch, capsys):
    sync = sync_module()
    copy = tmp_path / "dock"
    shutil.copytree(sync.DOCK_DIR, copy)
    with (copy / "keys.ts").open("a", encoding="utf-8") as f:
        f.write("\n")
    (copy / "extra.ts").write_text("import { api } from '../io/api';\n", encoding="utf-8")
    monkeypatch.setattr(sync, "DOCK_DIR", copy)
    assert sync.dock_drift() == ["extra.ts", "keys.ts"]
    assert sync.dock_strangers() == ["extra.ts imports ../io/api"]
    monkeypatch.setattr(sync, "skills", lambda check, said: 0)
    assert sync.sync(True) == 1
    said = capsys.readouterr().out
    assert "frontend/src/dock/keys.ts does not match frontend/src/dock/MANIFEST.json" in said
    assert "frontend/src/dock/extra.ts imports ../io/api" in said


def test_the_manifest_dock_block_is_what_the_adapter_offers():
    adapter = (REPO / "frontend" / "src" / "dock-adapter.ts").read_text(encoding="utf-8")
    offered = re.search(r"builtin: \[([^\]]+)\]", adapter).group(1).replace("'", "").replace(" ", "").split(",")
    dock = committed()["dock"]
    assert sorted(offered) == dock["tabs"]
    assert dock["positions"] == ["bottom", "right"]
    assert "mode: 'own'" in adapter


def test_the_dock_storage_key_and_the_old_keys_are_the_ones_the_pre_paint_script_reads():
    adapter = (REPO / "frontend" / "src" / "dock-adapter.ts").read_text(encoding="utf-8")
    page = (REPO / "frontend" / "index.html").read_text(encoding="utf-8")
    assert "export const DOCK_KEY = 'formpdf.dock';" in adapter
    assert "export const DOCK_OLD_KEYS = ['fs-dock-h', 'fs-dock-last'];" in adapter
    assert "localStorage.getItem('formpdf.dock')" in page
    assert page.index("localStorage.getItem('formpdf.dock')") < page.index('<link rel="stylesheet"')
    assert not (REPO / "frontend" / "src" / "ui" / "terminal-dock.ts").exists()


LOOKUP = "backend/app/services/agent_lookup.py"


def test_the_shared_finder_matches_the_hash_recorded_for_its_version():
    sync = sync_module()
    version = re.search(r'^VERSION = "([^"]+)"$', (REPO / LOOKUP).read_text(encoding="utf-8"), re.M).group(1)
    assert sync.LOOKUP_HASHES[version] == hashlib.sha256((REPO / LOOKUP).read_bytes()).hexdigest()
    assert sync.lookup_problems() == []


def test_the_check_names_the_shared_finder_edited_in_place_or_missing(tmp_path, monkeypatch):
    sync = sync_module()
    copy = tmp_path / "repo"
    (copy / "backend" / "app" / "services").mkdir(parents=True)
    shutil.copy(REPO / LOOKUP, copy / LOOKUP)
    monkeypatch.setattr(sync, "ROOT", copy)
    monkeypatch.setattr(sync, "LOOKUP", copy / LOOKUP)
    assert sync.lookup_problems() == []
    with open(copy / LOOKUP, "a", encoding="utf-8") as f:
        f.write("\n")
    version = re.search(r'^VERSION = "([^"]+)"$', (REPO / LOOKUP).read_text(encoding="utf-8"), re.M).group(1)
    assert sync.lookup_problems() == [f"{LOOKUP}: does not match the hash recorded for version {version} (the shared finder changes only as a whole new version)"]
    (copy / LOOKUP).unlink()
    assert sync.lookup_problems() == [f"{LOOKUP}: missing (the shared finder for the agent programs)"]


def test_the_shared_finder_imports_nothing_from_the_app():
    imports = set(re.findall(r"^\s*(?:from|import)\s+([\w.]+)", (REPO / LOOKUP).read_text(encoding="utf-8"), re.M))
    assert imports == {"__future__", "dataclasses", "os", "pathlib", "re", "shutil", "signal", "subprocess", "sys", "threading", "time", "winreg"}
