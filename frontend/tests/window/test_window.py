import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

WINDOW_DIR = Path(__file__).resolve().parent
REPO = WINDOW_DIR.parents[2]

APP_ID = "formpdf"
ENGINE_DIR = REPO / "backend"
ENGINE_CMD = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "{port}"]
ENGINE_ENV = {"FORMPDF_DATA_DIR": "{data}", "FORMPDF_PORT": "{port}", "FORMPDF_DIST": "{dist}"}
CLEAR_ENV_PREFIX = "FORMPDF_"
DIST = REPO / "frontend" / "dist"
HEALTH_PATH = "/api/health"
PAGES = ["/", "/splash.html"]
SETTLE_MS = 3000
CLS_LIMIT = 0.0
IGNORED_REQUESTS = []

CPU_SLOWDOWN = 4
NETWORK = {"offline": False, "latency": 150, "downloadThroughput": 1_600_000 / 8, "uploadThroughput": 750_000 / 8}

CLS_PROBE = """
window.__cls = 0;
window.__shifts = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (e.hadRecentInput) continue;
    window.__cls += e.value;
    const who = (e.sources || []).map((s) => s.node ? `${s.node.nodeName}.${String(s.node.className || '').trim().split(/\\s+/)[0]}` : '?');
    window.__shifts.push(`${Math.round(e.startTime)}ms ${e.value.toExponential(2)} ${who.join(',')}`);
  }
}).observe({ type: 'layout-shift', buffered: true });
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def engine():
    assert (DIST / "index.html").is_file(), f"build the window first: {DIST} has no index.html (npm run build)"
    port = free_port()
    sandbox = Path(tempfile.mkdtemp(prefix=f"{APP_ID}-window-"))
    (sandbox / "data").mkdir()
    (sandbox / "home").mkdir()
    values = {"port": str(port), "data": str(sandbox / "data"), "dist": str(DIST)}
    env = {k: v for k, v in os.environ.items() if not k.startswith(CLEAR_ENV_PREFIX)}
    env.update({k: v.format(**values) for k, v in ENGINE_ENV.items()})
    env["HOME"] = str(sandbox / "home")
    proc = subprocess.Popen([a.format(**values) for a in ENGINE_CMD], cwd=ENGINE_DIR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline and proc.poll() is None:
        try:
            with urllib.request.urlopen(base + HEALTH_PATH, timeout=2) as r:
                if r.status == 200:
                    break
        except OSError:
            time.sleep(0.25)
    else:
        proc.kill()
        out = proc.communicate(timeout=5)[0].decode("utf-8", "replace")
        raise RuntimeError(f"engine did not answer {HEALTH_PATH}:\n{out[-4000:]}")
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(sandbox, ignore_errors=True)


def ignored(url):
    return any(part in url for part in IGNORED_REQUESTS)


@pytest.mark.parametrize("path", PAGES)
def test_window_loads_throttled_without_shift_errors_or_refusals(engine, path):
    from playwright.sync_api import sync_playwright

    errors, failed = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.add_init_script(CLS_PROBE)
        cdp = page.context.new_cdp_session(page)
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": CPU_SLOWDOWN})
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", NETWORK)
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("requestfailed", lambda r: failed.append(f"{r.url} {r.failure}") if not ignored(r.url) else None)
        page.on("response", lambda r: failed.append(f"{r.url} {r.status}") if r.status >= 400 and not ignored(r.url) else None)
        page.goto(engine + path, wait_until="load", timeout=120_000)
        page.wait_for_load_state("networkidle", timeout=120_000)
        page.wait_for_timeout(SETTLE_MS)
        cls = page.evaluate("window.__cls")
        shifts = page.evaluate("window.__shifts")
        title = page.title()
        browser.close()
    assert title, "the window has a title"
    assert not [f for f in failed if " 403" in f], f"requests refused by the guard: {failed}"
    assert not failed, f"failed requests: {failed}"
    assert not errors, f"console errors: {errors}"
    assert cls <= CLS_LIMIT, f"layout shift {cls}: {shifts}"


DEMOS = [("pages", "view", "alice-in-wonderland.pdf", 53), ("sign", "fill", "telescope-loan-agreement.pdf", 2), ("protect", "protect", "season-report-final.pdf", 4)]


def test_every_demo_opens_from_start_as_a_new_pdf(engine):
    from playwright.sync_api import sync_playwright

    errors, seen = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(engine + "/", wait_until="networkidle", timeout=120_000)
        for demo, tab, name, pages in DEMOS:
            page.wait_for_selector(".fs-home:not([hidden])", timeout=30_000)
            page.locator(f"[data-home-demos] [data-demo='{demo}']").click()
            page.wait_for_function("([t, n, c]) => { const r = document.querySelector('.fs-pdfwb'); return r && !r.hidden && r.dataset.tab === t && r.querySelector('.fs-pdfwb-name')?.textContent === n && r.querySelectorAll('.fs-pdf-page').length === c; }", arg=[tab, name, pages], timeout=60_000)
            seen.append((demo, page.evaluate("() => document.querySelector('.fs-pdfwb .fs-pdfwb-edited')?.className ?? 'missing is-off'")))
            page.keyboard.press("Alt+ControlOrMeta+KeyH")
            page.locator(".fs-pdfwb-bar:not([hidden]) .fs-btn-danger").click(timeout=15_000)
        browser.close()
    assert [d for d, _ in seen] == [d for d, *_ in DEMOS]
    assert all("is-off" not in c for _, c in seen), f"a demo should open as an unsaved PDF: {seen}"
    assert not errors, f"page errors: {errors}"
