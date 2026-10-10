import io
import json
import mimetypes
import re
from pathlib import Path

from app.core import config, ids

EXT_BY_MIME = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/tiff": ".tif"}
_PIL_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp", "BMP": "image/bmp", "TIFF": "image/tiff", "MPO": "image/jpeg"}


def sniff_mime(data: bytes, name: str) -> str:
    head = data[:16]
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    guess, _ = mimetypes.guess_type(name)
    return guess or "application/octet-stream"


def probe(data: bytes) -> dict:
    info: dict = {}
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            info["w"], info["h"] = im.size
            if im.format in _PIL_MIME:
                info["_mime"] = _PIL_MIME[im.format]
    except Exception:
        pass
    return info


class MediaStore:
    def __init__(self, root: Path | None = None):
        self.root = root or config.media_dir()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, data: bytes, name: str, mime: str | None = None) -> dict:
        mime = mime or sniff_mime(data, name)
        extra = probe(data) if mime.startswith("image/") else {}
        mime = extra.pop("_mime", mime)
        mid = ids.media_id(data, "image" if mime.startswith("image/") else "doc")
        ext = EXT_BY_MIME.get(mime) or Path(name).suffix.lower() or ".bin"
        path = self.root / f"{mid}{ext}"
        meta = {"id": mid, "name": Path(name).name or mid, "mime": mime, "bytes": len(data), **extra}
        if not path.exists():
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        (self.root / f"{mid}.json").write_text(json.dumps(meta), encoding="utf-8")
        return meta

    def path(self, media_id: str) -> Path | None:
        if not re.fullmatch(r"[a-z]{3}_[0-9a-f]{8,16}", media_id or ""):
            return None
        for p in self.root.glob(f"{media_id}.*"):
            if p.suffix not in (".json", ".tmp"):
                return p
        return None

    def info(self, media_id: str) -> dict | None:
        try:
            return json.loads((self.root / f"{media_id}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            p = self.path(media_id)
            if p is None:
                return None
            data = p.read_bytes()
            mime = sniff_mime(data, p.name)
            return {"id": media_id, "name": p.name, "mime": mime, "bytes": len(data), **{k: v for k, v in probe(data).items() if not k.startswith("_")}}


_store: MediaStore | None = None


def store() -> MediaStore:
    global _store
    if _store is None:
        _store = MediaStore()
    return _store
