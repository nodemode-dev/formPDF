import ipaddress
import os
import platform
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

MDNS = ("224.0.0.251", 5353)
SERVICES = ("_uscan._tcp.local", "_uscans._tcp.local")
PWG = "http://www.pwg.org/schemas/2010/12/sm"
SCAN = "http://schemas.hp.com/imaging/escl/2011/05/03"
MAX_PAGES = 200
TIMEOUT = 20


def _name(data: bytes, off: int) -> tuple[str, int]:
    labels, jumped, end, hops = [], False, off, 0
    while off < len(data) and hops < 64:
        n = data[off]
        if n == 0:
            off += 1
            break
        if n & 0xC0 == 0xC0:
            if off + 1 >= len(data):
                break
            ptr = ((n & 0x3F) << 8) | data[off + 1]
            if not jumped:
                end = off + 2
            off, jumped, hops = ptr, True, hops + 1
            continue
        labels.append(data[off + 1:off + 1 + n].decode("utf-8", "replace"))
        off += 1 + n
    return ".".join(labels), (end if jumped else off)


def parse_mdns(data: bytes) -> list[dict]:
    if len(data) < 12:
        return []
    _, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", data[:12])
    off = 12
    for _ in range(qd):
        _, off = _name(data, off)
        off += 4
    recs = []
    for _ in range(an + ns + ar):
        if off >= len(data):
            break
        name, off = _name(data, off)
        if off + 10 > len(data):
            break
        rtype, _cls, _ttl, rdlen = struct.unpack("!HHIH", data[off:off + 10])
        off += 10
        rd = data[off:off + rdlen]
        rec = {"name": name.lower(), "type": rtype}
        if rtype == 12:
            rec["target"] = _name(data, off)[0]
        elif rtype == 33 and rdlen >= 6:
            rec["port"] = struct.unpack("!H", rd[4:6])[0]
            rec["host"] = _name(data, off + 6)[0].lower()
        elif rtype == 16:
            txt, i = {}, 0
            while i < len(rd):
                n = rd[i]
                part = rd[i + 1:i + 1 + n].decode("utf-8", "replace")
                if "=" in part:
                    k, v = part.split("=", 1)
                    txt[k.lower()] = v
                i += 1 + n
            rec["txt"] = txt
        elif rtype == 1 and rdlen == 4:
            rec["ip"] = socket.inet_ntoa(rd)
        elif rtype == 28 and rdlen == 16:
            rec["ip6"] = socket.inet_ntop(socket.AF_INET6, rd)
        recs.append(rec)
        off += rdlen
    return recs


def _query(service: str) -> bytes:
    msg = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0)
    for label in service.split("."):
        msg += bytes([len(label)]) + label.encode()
    return msg + b"\x00" + struct.pack("!HH", 12, 0x8001)


def _assemble(recs: list[dict]) -> list[dict]:
    instances = {r["target"].lower(): r["name"] for r in recs if r["type"] == 12 and r["name"] in SERVICES}
    srv = {r["name"]: r for r in recs if r["type"] == 33}
    txt = {r["name"]: r.get("txt", {}) for r in recs if r["type"] == 16}
    addr = {}
    for r in recs:
        if r["type"] == 1:
            addr.setdefault(r["name"], r["ip"])
    out = []
    for inst, service in instances.items():
        s = srv.get(inst)
        if not s:
            continue
        ip = addr.get(s["host"])
        if not ip:
            continue
        t = txt.get(inst, {})
        scheme = "https" if service.startswith("_uscans") else "http"
        rs = t.get("rs", "eSCL").strip("/")
        label = t.get("ty") or inst.split("._uscan")[0]
        out.append({"id": f"escl:{scheme}://{ip}:{s['port']}/{rs}", "name": label, "kind": "network", "address": f"{ip}:{s['port']}"})
    return out


def discover_escl(wait: float = 2.0) -> list[dict]:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    except OSError:
        return []
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        sock.settimeout(0.25)
        sock.bind(("", 0))
        for svc in SERVICES:
            try:
                sock.sendto(_query(svc), MDNS)
            except OSError:
                return []
        recs: list[dict] = []
        end = time.monotonic() + wait
        while time.monotonic() < end:
            try:
                data, src = sock.recvfrom(9000)
            except socket.timeout:
                continue
            except OSError:
                break
            if _private(src[0]):
                recs += parse_mdns(data)
        return _assemble(recs)
    finally:
        sock.close()


def _private(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_link_local or ip.is_loopback


def escl_base(address: str) -> str:
    raw = address.strip()
    if not raw:
        raise ValueError("Give the scanner's address, such as 192.168.1.20")
    if "://" not in raw:
        raw = "http://" + raw
    u = urllib.parse.urlsplit(raw)
    host = u.hostname or ""
    if not _private(host) and not host.endswith(".local"):
        raise ValueError("formpdf only talks to scanners on your own network (a 10.x, 172.16-31.x, 192.168.x or .local address)")
    path = u.path.strip("/") or "eSCL"
    return f"{u.scheme}://{u.netloc}/{path}"


def _http(method: str, url: str, body: bytes | None = None, ctype: str = "text/xml") -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": ctype} if body else {})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read() if e.fp else b""
    except (urllib.error.URLError, OSError) as e:
        raise ValueError(f"The scanner at {urllib.parse.urlsplit(url).netloc} did not answer ({getattr(e, 'reason', e)})") from None


def escl_capabilities(base: str) -> dict:
    status, _, data = _http("GET", f"{base}/ScannerCapabilities")
    if status != 200:
        raise ValueError(f"The scanner refused to describe itself (HTTP {status})")
    root = ET.fromstring(data)
    ns = {"pwg": PWG, "scan": SCAN}
    name = root.findtext("pwg:MakeAndModel", default="", namespaces=ns)
    sources, dpis, modes = [], set(), set()
    for tag, label in (("Platen", "glass"), ("Adf", "feeder")):
        el = root.find(f"scan:{tag}", ns)
        if el is None:
            continue
        sources.append(label)
        for r in el.iter(f"{{{SCAN}}}XResolution"):
            try:
                dpis.add(int(r.text or 0))
            except ValueError:
                pass
        for m in el.iter(f"{{{SCAN}}}ColorMode"):
            modes.add(m.text or "")
        if tag == "Adf" and el.find("scan:AdfDuplexInputCaps", ns) is not None:
            sources.append("feeder, both sides")
    return {"name": name, "sources": sources or ["glass"], "dpis": sorted(d for d in dpis if d) or [300],
            "color": "RGB24" in modes, "gray": "Grayscale8" in modes}


def _settings(source: str, dpi: int, color: bool, fmt: str) -> bytes:
    src = {"glass": "Platen", "feeder": "Feeder", "feeder, both sides": "Feeder"}.get(source, "Platen")
    duplex = "<scan:Duplex>true</scan:Duplex>" if source == "feeder, both sides" else ""
    return (f'<?xml version="1.0" encoding="UTF-8"?><scan:ScanSettings xmlns:scan="{SCAN}" xmlns:pwg="{PWG}">'
            f"<pwg:Version>2.0</pwg:Version><scan:Intent>Document</scan:Intent><pwg:InputSource>{src}</pwg:InputSource>"
            f"<scan:ColorMode>{'RGB24' if color else 'Grayscale8'}</scan:ColorMode><scan:XResolution>{dpi}</scan:XResolution>"
            f"<scan:YResolution>{dpi}</scan:YResolution><pwg:DocumentFormat>{fmt}</pwg:DocumentFormat>"
            f"<scan:DocumentFormatExt>{fmt}</scan:DocumentFormatExt>{duplex}</scan:ScanSettings>").encode()


def escl_scan(base: str, *, source: str = "glass", dpi: int = 300, color: bool = True) -> list[tuple[str, bytes]]:
    status, headers, _ = _http("POST", f"{base}/ScanJobs", _settings(source, dpi, color, "image/jpeg"))
    if status not in (200, 201):
        if status == 409 or status == 503:
            raise ValueError("The scanner is busy. Try again when it is idle.")
        raise ValueError(f"The scanner did not accept the job (HTTP {status}). Check that paper is in the feeder or on the glass.")
    loc = {k.lower(): v for k, v in headers.items()}.get("location", "")
    if not loc:
        raise ValueError("The scanner did not say where the scan is")
    job = urllib.parse.urljoin(base + "/", loc)
    pages: list[tuple[str, bytes]] = []
    tries = 0
    while len(pages) < MAX_PAGES:
        status, _, data = _http("GET", f"{job.rstrip('/')}/NextDocument")
        if status == 200 and data:
            pages.append((f"scan{len(pages) + 1}.jpg", data))
            tries = 0
            if source == "glass":
                break
            continue
        if status == 503 and tries < 30:
            tries += 1
            time.sleep(1)
            continue
        break
    if not pages:
        raise ValueError("The scanner finished without a page. Check that paper is in the feeder or on the glass.")
    return pages


def _run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)


def sane_devices() -> list[dict]:
    tool = shutil.which("scanimage")
    if not tool:
        return []
    try:
        r = _run([tool, "-f", "%d\t%v %m%n"], timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return []
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        dev, _, label = line.partition("\t")
        if dev and not dev.startswith("escl:") and not dev.startswith("airscan:"):
            out.append({"id": f"sane:{dev}", "name": label.strip() or dev, "kind": "usb"})
    return out


def sane_scan(dev: str, *, source: str = "glass", dpi: int = 300, color: bool = True) -> list[tuple[str, bytes]]:
    tool = shutil.which("scanimage")
    if not tool:
        raise ValueError("SANE's scanimage is not installed")
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [tool, "-d", dev, "--resolution", str(dpi), "--mode", "Color" if color else "Gray", "--format=png"]
        if source.startswith("feeder"):
            cmd += ["--source", "ADF Duplex" if "both" in source else "ADF", f"--batch={tmp}/p%03d.png"]
            r = _run(cmd)
            files = sorted(Path(tmp).glob("p*.png"))
        else:
            out = Path(tmp) / "p001.png"
            r = _run(cmd + [f"--output-file={out}"])
            files = [out] if out.exists() else []
        if not files:
            msg = r.stderr.decode("utf-8", "replace").strip().splitlines()
            raise ValueError(f"The scanner did not scan: {msg[-1] if msg else 'no page'}")
        return [(f.name, f.read_bytes()) for f in files[:MAX_PAGES]]


WIA_LIST = "$m=New-Object -ComObject WIA.DeviceManager; foreach($d in $m.DeviceInfos){ if($d.Type -eq 1){ $d.DeviceID + \"`t\" + $d.Properties.Item('Name').Value } }"
WIA_SCAN = ("$m=New-Object -ComObject WIA.DeviceManager; $i=$m.DeviceInfos | Where-Object { $_.DeviceID -eq $env:FP_DEV } | Select-Object -First 1; "
            "$d=$i.Connect(); $it=$d.Items.Item(1); "
            "foreach($p in $it.Properties){ if($p.PropertyID -eq 6147 -or $p.PropertyID -eq 6148){ $p.Value=[int]$env:FP_DPI }; "
            "if($p.PropertyID -eq 6146){ $p.Value=[int]$env:FP_INTENT } }; "
            "$n=0; do { $img=$it.Transfer('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'); $n++; $img.SaveFile((Join-Path $env:FP_OUT ('p{0:D3}.jpg' -f $n))) } "
            "while ($env:FP_FEED -eq '1' -and $n -lt 200)")


def wia_devices() -> list[dict]:
    if platform.system() != "Windows":
        return []
    try:
        r = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WIA_LIST], timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return []
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        dev, _, label = line.partition("\t")
        if dev.strip():
            out.append({"id": f"wia:{dev.strip()}", "name": label.strip() or "Scanner", "kind": "usb"})
    return out


def wia_scan(dev: str, *, source: str = "glass", dpi: int = 300, color: bool = True) -> list[tuple[str, bytes]]:
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "FP_DEV": dev, "FP_DPI": str(dpi), "FP_INTENT": "1" if color else "2", "FP_OUT": tmp,
               "FP_FEED": "1" if source.startswith("feeder") else "0"}
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WIA_SCAN], capture_output=True, timeout=600, env=env, check=False)
        files = sorted(Path(tmp).glob("p*.jpg"))
        if not files:
            msg = r.stderr.decode("utf-8", "replace").strip().splitlines()
            raise ValueError(f"The scanner did not scan: {msg[-1] if msg else 'no page'}")
        return [(f.name, f.read_bytes()) for f in files]


def devices() -> list[dict]:
    seen, out = set(), []
    for d in discover_escl() + sane_devices() + wia_devices():
        if d["id"] not in seen:
            seen.add(d["id"])
            out.append(d)
    return out


def capabilities(device: str) -> dict:
    if device.startswith("escl:"):
        return escl_capabilities(device[5:])
    return {"name": "", "sources": ["glass", "feeder", "feeder, both sides"], "dpis": [150, 200, 300, 600], "color": True, "gray": True}


def scan(device: str, *, source: str = "glass", dpi: int = 300, color: bool = True) -> list[tuple[str, bytes]]:
    dpi = max(75, min(int(dpi or 300), 1200))
    if device.startswith("escl:"):
        return escl_scan(device[5:], source=source, dpi=dpi, color=color)
    if device.startswith("sane:"):
        return sane_scan(device[5:], source=source, dpi=dpi, color=color)
    if device.startswith("wia:"):
        return wia_scan(device[4:], source=source, dpi=dpi, color=color)
    raise ValueError("Pick a scanner from the list, or give a network scanner's address")
