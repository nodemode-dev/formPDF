import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import REPO

pytestmark = pytest.mark.skipif(os.name == "nt" or not shutil.which("bash"), reason="the freeze script is bash")

OCR_MODULES = ("rapidocr", "onnxruntime", "shapely", "pyclipper")

FAKE_PYINSTALLER = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FREEZE_ARGS"
mkdir -p dist-engine
cat > dist-engine/formpdf-engine <<'ENGINE'
#!/usr/bin/env bash
echo '{"ok": true, "ocr": false}'
ENGINE
chmod +x dist-engine/formpdf-engine
"""


def fake_tree(tmp_path: Path) -> tuple[Path, dict]:
    root = tmp_path / "repo"
    (root / "setup").mkdir(parents=True)
    for name in ("lib.sh", "freeze_backend"):
        shutil.copy2(REPO / "setup" / name, root / "setup" / name)
    (root / "backend" / "venv" / "bin").mkdir(parents=True)
    (root / "backend" / "venv" / "bin" / "activate").write_text("", encoding="utf-8")
    (root / "frontend" / "dist").mkdir(parents=True)
    (root / "frontend" / "dist" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    mods = tmp_path / "mods"
    for name in (*OCR_MODULES, "PyInstaller", "cv2"):
        (mods / name).mkdir(parents=True)
        (mods / name / "__init__.py").write_text("", encoding="utf-8")
    (mods / "cv2" / ".dylibs").mkdir()
    (mods / "cv2" / ".dylibs" / "libx264.164.dylib").write_bytes(b"")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "python").symlink_to(sys.executable)
    (bin_dir / "uname").write_text("#!/usr/bin/env bash\necho Darwin\n", encoding="utf-8")
    (bin_dir / "pyinstaller").write_text(FAKE_PYINSTALLER, encoding="utf-8")
    for tool in ("uname", "pyinstaller"):
        (bin_dir / tool).chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("FORMPDF_", "FORMCOMPILER_", "PYTHON", "APPLE_", "TAURI_SIGNING_"))}
    env.update({
        "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
        "PYTHONPATH": str(mods),
        "PYTHONNOUSERSITE": "1",
        "FORMPDF_TARGET": "aarch64-apple-darwin",
        "FREEZE_ARGS": str(tmp_path / "args.txt"),
    })
    return root, env


def freeze(root: Path, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(root / "setup" / "freeze_backend")], env=env, capture_output=True, text=True, timeout=60)


def test_a_dev_freeze_with_gpl_opencv_builds_a_sidecar_without_ocr(tmp_path):
    root, env = fake_tree(tmp_path)
    env["FORMPDF_DEV_FREEZE"] = "1"
    run = freeze(root, env)
    assert run.returncode == 0, run.stdout + run.stderr
    args = (tmp_path / "args.txt").read_text(encoding="utf-8").split("\n")
    assert "rapidocr" not in [args[i + 1] for i, a in enumerate(args[:-1]) if a == "--collect-all"]
    excluded = {args[i + 1] for i, a in enumerate(args[:-1]) if a == "--exclude-module"}
    assert {"cv2", "rapidocr", "onnxruntime"} <= excluded
    assert (root / "src-tauri" / "binaries" / "formpdf-engine-aarch64-apple-darwin").is_file()
    said = run.stdout + run.stderr
    assert "without text recognition" in said and "PIP_NO_BINARY=opencv-python,opencv-python-headless" in said


def test_a_release_freeze_with_gpl_opencv_still_stops(tmp_path):
    root, env = fake_tree(tmp_path)
    env["FORMCOMPILER_VERSION"] = "0.0.0"
    run = freeze(root, env)
    assert run.returncode != 0
    assert "GPL FFmpeg library in OpenCV" in run.stderr
    assert not (tmp_path / "args.txt").exists()


def test_a_release_freeze_without_ocr_still_stops_on_gpl_opencv(tmp_path):
    root, env = fake_tree(tmp_path)
    env.update({"FORMCOMPILER_VERSION": "0.0.0", "FORMPDF_NO_OCR": "1"})
    run = freeze(root, env)
    assert run.returncode != 0
    assert "GPL FFmpeg library in OpenCV" in run.stderr


def test_a_freeze_without_the_dev_flag_stops_on_gpl_opencv(tmp_path):
    root, env = fake_tree(tmp_path)
    run = freeze(root, env)
    assert run.returncode != 0
    assert "GPL FFmpeg library in OpenCV" in run.stderr
    assert not (tmp_path / "args.txt").exists()


@pytest.mark.parametrize("name, value", [
    ("FORMCOMPILER_VERSION", ""),
    ("FORMCOMPILER_VERSION", "0.0.0"),
    ("APPLE_SIGNING_IDENTITY", "Developer ID Application: Example"),
    ("APPLE_CERTIFICATE", ""),
    ("TAURI_SIGNING_PRIVATE_KEY", "key"),
])
def test_a_release_or_signed_freeze_stops_even_with_the_dev_flag(tmp_path, name, value):
    root, env = fake_tree(tmp_path)
    env.update({"FORMPDF_DEV_FREEZE": "1", name: value})
    run = freeze(root, env)
    assert run.returncode != 0
    assert "GPL FFmpeg library in OpenCV" in run.stderr
    assert not (tmp_path / "args.txt").exists()


def test_only_desktop_dev_sets_the_dev_freeze_flag():
    assert "FORMPDF_DEV_FREEZE=1" in (REPO / "setup" / "desktop_dev").read_text(encoding="utf-8")
    assert "FORMPDF_DEV_FREEZE=1" in (REPO / "setup" / "desktop_dev.bat").read_text(encoding="utf-8")
    for name in ("build_app", "build_app.bat", "formpdf", "formpdf.bat", "setup/desktop_build", "setup/desktop_build.bat", "setup/freeze_backend.bat"):
        path = REPO / name
        if path.exists():
            assert "FORMPDF_DEV_FREEZE" not in path.read_text(encoding="utf-8", errors="replace"), name
