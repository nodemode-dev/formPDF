import io

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

SECRET = "SECRET-4471"


def letter(lines_per_page):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(612, 792))
    for lines in lines_per_page:
        c.setFont("Helvetica", 14)
        y = 700
        for line in lines:
            c.drawString(72, y, line)
            y -= 50
        c.showPage()
    c.save()
    return buf.getvalue()


def private_letter():
    return letter([["Public line stays here", f"Account {SECRET} is private"], ["Second page"]])


def three_pages():
    return letter([["Page one"], ["Page two"], ["Page three"]])


def with_hidden_things():
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(private_letter())))
    w.add_js("app.alert('hello');")
    w.add_attachment("notes.txt", b"private notes")
    w.add_metadata({"/Author": "Jane Example", "/Title": "Secret plan"})
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def form():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(612, 792))
    c.drawString(72, 750, "Name:")
    c.acroForm.textfield(name="fullname", x=120, y=740, width=200, height=20)
    c.save()
    return buf.getvalue()


def picture_with_mask():
    from PIL import Image
    from reportlab.lib.utils import ImageReader

    im = Image.new("RGBA", (64, 64))
    for x in range(64):
        for y in range(64):
            im.putpixel((x, y), (x * 4 % 256, y * 4 % 256, 77, 255 if (x + y) % 3 else 90))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(612, 792))
    c.drawImage(ImageReader(im), 100, 500, 128, 128, mask="auto")
    c.drawString(72, 300, "Caption stays")
    c.save()
    data = buf.getvalue()
    image = next(iter(PdfReader(io.BytesIO(data)).pages[0]["/Resources"]["/XObject"].values())).get_object()
    return data, image.get_data(), image["/SMask"].get_object().get_data()


def with_bookmark():
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(three_pages())))
    top = w.add_outline_item("Private chapter title", 0)
    w.add_outline_item("Private section title", 1, parent=top)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def open_pdf(client, data, name="document.pdf"):
    r = client.post("/api/pdf/open", files={"file": (name, data, "application/pdf")})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def file_bytes(client, doc_id):
    r = client.get(f"/api/pdf/{doc_id}/file")
    assert r.status_code == 200, r.text
    return r.content


def page_texts(client, doc_id):
    r = client.get(f"/api/pdf/{doc_id}/text")
    assert r.status_code == 200, r.text
    return [p["text"] for p in r.json()["pages"]]


def every_text(data):
    import pypdfium2 as pdfium

    found = []
    for page in PdfReader(io.BytesIO(data)).pages:
        found.append(page.extract_text() or "")
    doc = pdfium.PdfDocument(data)
    try:
        for k in range(len(doc)):
            tp = doc[k].get_textpage()
            found.append(tp.get_text_range())
    finally:
        doc.close()
    return "\n".join(found)


def every_stream(data):
    r = PdfReader(io.BytesIO(data))
    seen = []
    for num in range(1, int(r.trailer["/Size"])):
        try:
            obj = r.get_object(num)
        except Exception:
            continue
        if obj is None:
            continue
        try:
            seen.append(obj.get_data())
        except Exception:
            seen.append(str(obj).encode("latin-1", "replace"))
    return b"\n".join(seen)
