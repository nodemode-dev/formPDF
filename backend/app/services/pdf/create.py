import io
from pathlib import Path

from pypdf import PdfReader, PdfWriter

from app.services import office

from . import core

PAPER = {"a4": (595.276, 841.89), "letter": (612.0, 792.0)}
MAX_ITEMS = 500
MAX_SIDE = 14400.0
PICTURES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff")


def _frames(data: bytes, name: str):
    from PIL import Image, ImageOps, ImageSequence

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise ValueError(f"{name} is not a picture formpdf can read (PNG, JPEG, GIF, WebP, BMP or TIFF)") from None
    is_jpeg = img.format == "JPEG"
    frames = [img] if img.format in ("GIF", "WEBP", "PNG") or not getattr(img, "n_frames", 1) > 1 else list(ImageSequence.Iterator(img))
    out = []
    for k, fr in enumerate(frames):
        fr = fr.copy() if k else fr
        dpi = fr.info.get("dpi") or img.info.get("dpi")
        try:
            dpi = float(dpi[0]) if dpi and float(dpi[0]) >= 30 else 96.0
        except (TypeError, ValueError, IndexError):
            dpi = 96.0
        orient = 1
        try:
            orient = int(fr.getexif().get(0x0112, 1))
        except Exception:
            orient = 1
        raw = data if is_jpeg and orient == 1 and len(frames) == 1 and fr.mode in ("RGB", "L", "CMYK") else None
        if raw is None:
            fr = ImageOps.exif_transpose(fr)
            if fr.mode in ("P", "LA", "PA"):
                fr = fr.convert("RGBA")
            elif fr.mode not in ("RGB", "RGBA", "L"):
                fr = fr.convert("RGB")
        out.append((fr, raw, dpi))
    return out


def _picture_page(fr, raw: bytes | None, dpi: float, *, page: str, margin: float, orientation: str) -> bytes:
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    pw, ph = fr.size
    iw, ih = pw * 72.0 / dpi, ph * 72.0 / dpi
    k = min(1.0, MAX_SIDE / max(iw + 2 * margin, ih + 2 * margin))
    iw, ih = iw * k, ih * k
    if page == "fit":
        W, H = iw + 2 * margin, ih + 2 * margin
        W, H = max(W, 36.0), max(H, 36.0)
    else:
        W, H = PAPER[page]
        wide = orientation == "landscape" or (orientation == "auto" and pw > ph)
        if wide:
            W, H = H, W
    aw, ah = max(1.0, W - 2 * margin), max(1.0, H - 2 * margin)
    s = min(aw / iw, ah / ih) if page != "fit" else 1.0
    dw, dh = iw * s, ih * s
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(W, H))
    c.setTitle("")
    src = ImageReader(io.BytesIO(raw)) if raw else ImageReader(fr)
    c.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh, mask="auto" if fr.mode == "RGBA" else None)
    c.showPage()
    c.save()
    return buf.getvalue()


def from_files(items: list[tuple[str, bytes]], out, *, page: str = "fit", margin: float = 0, orientation: str = "auto",
               title: str | None = None) -> dict:
    if not items:
        raise ValueError("Add at least one PDF, picture or Office file")
    if len(items) > MAX_ITEMS:
        raise ValueError(f"Combine at most {MAX_ITEMS} files at a time")
    page = str(page or "fit").lower()
    if page not in ("fit", *PAPER):
        raise ValueError("The page size is fit, a4 or letter")
    orientation = str(orientation or "auto").lower()
    if orientation not in ("auto", "portrait", "landscape"):
        raise ValueError("The orientation is auto, portrait or landscape")
    try:
        margin = max(0.0, min(144.0, float(margin or 0)))
    except (TypeError, ValueError):
        raise ValueError("The margin must be a number of points") from None
    w = PdfWriter()
    pictures = pdfs = documents = 0
    for name, data in items:
        low = name.lower()
        if data[:1024].find(b"%PDF-") >= 0:
            r = PdfReader(io.BytesIO(data))
            if r.is_encrypted:
                try:
                    if not r.decrypt(""):
                        raise core.Locked(f"{name} is password protected. Unlock it in the workbench first.")
                except core.Locked:
                    raise
                except Exception:
                    raise core.Locked(f"{name} is password protected. Unlock it in the workbench first.") from None
            w.append(r)
            pdfs += 1
            continue
        if office.is_office(low):
            w.append(PdfReader(io.BytesIO(office.convert(data, name))))
            documents += 1
            continue
        if not low.endswith(PICTURES) and not data[:4] in (b"\x89PNG", b"GIF8", b"RIFF") and data[:2] != b"\xff\xd8":
            raise ValueError(f"{name} is not a PDF, a picture or an Office file")
        for fr, raw, dpi in _frames(data, name):
            w.append(PdfReader(io.BytesIO(_picture_page(fr, raw, dpi, page=page, margin=margin, orientation=orientation))))
            pictures += 1
    if not len(w.pages):
        raise ValueError("Nothing to put in the PDF")
    w.add_metadata({"/Title": str(title or Path(items[0][0]).stem)[:200], "/Producer": "formpdf"})
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "pictures": pictures, "pdfs": pdfs, "documents": documents}
