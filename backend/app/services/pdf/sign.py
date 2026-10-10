import base64
import datetime
import hashlib
import io
import json
import logging
import re
import tempfile
import uuid
from pathlib import Path

from app.core import config

from . import actions, core, frame

for _name in ("pyhanko", "pyhanko_certvalidator"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)

CERTIFY = {"forms": "FILL_FORMS", "comments": "ANNOTATE", "none": "NO_CHANGES"}
MAX_PICTURE = 8 * 1024 * 1024


def _ids_dir() -> Path:
    d = config.data_dir() / "identities"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _trust_dir() -> Path:
    d = config.data_dir() / "trusted"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _when(dt) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).isoformat(timespec="seconds")


def _cert_info(cert) -> dict:
    from cryptography.x509.oid import NameOID

    def attr(name, oid):
        got = name.get_attributes_for_oid(oid)
        return got[0].value if got else ""

    der = cert.public_bytes(_enc().DER)
    return {"name": attr(cert.subject, NameOID.COMMON_NAME) or cert.subject.rfc4514_string(), "email": attr(cert.subject, NameOID.EMAIL_ADDRESS),
            "org": attr(cert.subject, NameOID.ORGANIZATION_NAME), "issuer": attr(cert.issuer, NameOID.COMMON_NAME) or cert.issuer.rfc4514_string(),
            "selfSigned": cert.subject == cert.issuer, "from": _when(cert.not_valid_before_utc), "to": _when(cert.not_valid_after_utc),
            "fingerprint": hashlib.sha256(der).hexdigest(), "der": base64.b64encode(der).decode()}


def _enc():
    from cryptography.hazmat.primitives import serialization

    return serialization.Encoding


def identities() -> list[dict]:
    out = []
    for meta in sorted(_ids_dir().glob("*.json")):
        try:
            info = json.loads(meta.read_text())
        except ValueError:
            continue
        if (meta.with_suffix(".p12")).is_file():
            out.append({k: v for k, v in info.items() if k != "der"})
    return out


def _store(p12: bytes, cert, label: str) -> dict:
    ident = uuid.uuid4().hex[:10]
    info = {"id": ident, "label": label, **_cert_info(cert)}
    (_ids_dir() / f"{ident}.p12").write_bytes(p12)
    (_ids_dir() / f"{ident}.json").write_text(json.dumps(info))
    return {k: v for k, v in info.items() if k != "der"}


def make_identity(name: str, email: str = "", org: str = "", password: str = "", years: int = 5) -> dict:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    name = re.sub(r"\s+", " ", str(name or "")).strip()[:120]
    if not name:
        raise ValueError("A digital ID needs your name")
    if len(password or "") < 6:
        raise ValueError("Choose a password of at least 6 characters; it protects the ID's private key")
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, name)]
    if org.strip():
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, org.strip()[:120]))
    if email.strip():
        attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, email.strip()[:200]))
    subject = x509.Name(attrs)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=365 * max(1, min(int(years), 20))))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False, data_encipherment=False,
                                         key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    p12 = pkcs12.serialize_key_and_certificates(name.encode()[:64], key, cert, None,
                                                serialization.BestAvailableEncryption(password.encode()))
    info = _store(p12, cert, name)
    trust(cert.public_bytes(serialization.Encoding.DER))
    return info


def import_identity(data: bytes, password: str) -> dict:
    from cryptography.hazmat.primitives.serialization import pkcs12

    try:
        key, cert, _extra = pkcs12.load_key_and_certificates(data, (password or "").encode() or None)
    except ValueError:
        raise ValueError("That password does not open this digital ID, or the file is not a .p12 or .pfx ID") from None
    if key is None or cert is None:
        raise ValueError("This file has no private key, so it cannot sign; a digital ID file (.p12 or .pfx) is needed")
    info = _store(data, cert, _cert_info(cert)["name"])
    return info


def delete_identity(ident: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{10}", ident or ""):
        raise ValueError("Unknown digital ID")
    for ext in (".p12", ".json"):
        (_ids_dir() / f"{ident}{ext}").unlink(missing_ok=True)


def trust(der: bytes) -> str:
    fp = hashlib.sha256(der).hexdigest()
    (_trust_dir() / f"{fp}.der").write_bytes(der)
    return fp


def untrust(fp: str) -> None:
    if re.fullmatch(r"[0-9a-f]{64}", fp or ""):
        (_trust_dir() / f"{fp}.der").unlink(missing_ok=True)


def _trust_roots() -> list:
    from asn1crypto import x509 as ax

    out = []
    for f in _trust_dir().glob("*.der"):
        try:
            out.append(ax.Certificate.load(f.read_bytes()))
        except Exception:
            continue
    return out


def _appearance(args: dict, w: float, h: float, signer: str, tmp: Path):
    from PIL import Image
    from pyhanko import stamp
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfgen import canvas as rlcanvas

    from . import fontkit

    w, h = max(40.0, w), max(16.0, h)
    lines = [f"Digitally signed by {signer}", f"Date: {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"]
    if args.get("reason"):
        lines.append(f"Reason: {str(args['reason'])[:80]}")
    if args.get("location"):
        lines.append(f"Location: {str(args['location'])[:80]}")
    c = rlcanvas.Canvas(str(tmp), pagesize=(w, h))
    left = 2.0
    picture = args.get("picture")
    if picture:
        raw = str(picture)
        data = base64.b64decode(raw.split(",", 1)[1] if raw.startswith("data:") else raw)
        if len(data) > MAX_PICTURE:
            raise ValueError("The signature picture is larger than 8 MB")
        img = Image.open(io.BytesIO(data))
        img.load()
        pw = w * 0.45
        k = min(pw / max(1, img.width), (h - 4) / max(1, img.height))
        c.drawImage(ImageReader(img.convert("RGBA")), 2, (h - img.height * k) / 2, img.width * k, img.height * k, mask="auto")
        left = pw + 6
    avail = w - left - 2
    size = min(9.0, (h - 4) / (len(lines) * 1.25))
    name = fontkit.font_name("sans")
    for ln in lines:
        size = min(size, avail / max(1.0, pdfmetrics.stringWidth(ln, name, 1.0)))
    size = max(3.0, size)
    y = h - 2 - size
    c.setFillColorRGB(0.1, 0.1, 0.12)
    for ln in lines:
        c.setFont(fontkit.pick(ln, "sans")[1], size)
        c.drawString(left, y, ln)
        y -= size * 1.25
    c.showPage()
    c.save()
    return stamp.StaticStampStyle.from_pdf_file(str(tmp), border_width=0)


def sign(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.sign.fields import FieldMDPAction, FieldMDPSpec, MDPPerm

    args = args or {}
    ident = str(args.get("identity") or "")
    p12 = _ids_dir() / f"{ident}.p12"
    if not re.fullmatch(r"[0-9a-f]{10}", ident) or not p12.is_file():
        raise ValueError("Choose a digital ID to sign with (make one, or import a .p12 or .pfx file)")
    try:
        signer = signers.SimpleSigner.load_pkcs12(str(p12), passphrase=str(args.get("password") or "").encode() or None)
    except Exception:
        signer = None
    if signer is None:
        raise ValueError("That password does not open the digital ID")
    data = Path(src).read_bytes()
    r = core.reader(src, passwords)
    w = IncrementalPdfFileWriter(io.BytesIO(data))
    if w.prev.encrypted:
        for pw in [*(passwords or []), ""]:
            try:
                w.encrypt(pw.encode())
                break
            except Exception:
                continue
    name = str(args.get("field") or "").strip()
    existing = {str(f.get("/T")): f for f in _sig_fields(r)}
    if name and name in existing:
        if existing[name].get("/V") is not None:
            raise ValueError(f"The signature field {name} is already signed")
        f = existing[name]
        rect = f.get("/Rect") or next((k.get_object().get("/Rect") for k in f.get("/Kids") or [] if k.get_object().get("/Rect")), None)
        q = [float(v) for v in rect] if rect else [0, 0, 160, 48]
        bw, bh = abs(q[2] - q[0]), abs(q[3] - q[1])
    else:
        box = args.get("box") or {}
        try:
            n = int(box.get("page", 0))
        except (TypeError, ValueError):
            n = 0
        if not 1 <= n <= len(r.pages):
            raise ValueError("Draw where the signature goes, or pick an empty signature field")
        x0, y0, x1, y1 = frame.to_pdf(r.pages[n - 1], *frame.box(box))
        bw, bh = abs(x1 - x0), abs(y1 - y0)
        base = name or "Signature"
        name, k = base, 1
        while name in existing:
            k += 1
            name = f"{base}{k}"
        spec = fields.SigFieldSpec(name, on_page=n - 1, box=(int(min(x0, x1)), int(min(y0, y1)), int(max(x0, x1)), int(max(y0, y1))))
        if args.get("lock"):
            spec = fields.SigFieldSpec(name, on_page=n - 1, box=spec.box, field_mdp_spec=FieldMDPSpec(FieldMDPAction.ALL))
        fields.append_signature_field(w, spec)
    certify = str(args.get("certify") or "")
    meta = signers.PdfSignatureMetadata(
        field_name=name, reason=str(args.get("reason") or "")[:200] or None, location=str(args.get("location") or "")[:200] or None,
        contact_info=str(args.get("contact") or "")[:200] or None, subfilter=fields.SigSeedSubFilter.PADES, md_algorithm="sha256",
        certify=certify in CERTIFY, docmdp_permissions=getattr(MDPPerm, CERTIFY.get(certify, "FILL_FORMS")),
        signer_key_usage={"digital_signature"})
    timestamper = None
    url = str(config.read_settings().get("timestampUrl") or "") if args.get("timestamp") else ""
    if url:
        from pyhanko.sign.timestamps import HTTPTimeStamper

        timestamper = HTTPTimeStamper(url, timeout=15)
    try:
        who = json.loads((_ids_dir() / f"{ident}.json").read_text()).get("name") or "the signer"
    except ValueError:
        who = "the signer"
    buf = io.BytesIO()
    with tempfile.TemporaryDirectory() as td:
        ps = signers.PdfSigner(meta, signer, stamp_style=_appearance(args, bw, bh, who, Path(td) / "look.pdf"), timestamper=timestamper)
        try:
            ps.sign_pdf(w, output=buf)
        except Exception as e:
            raise ValueError(f"Signing failed: {e}") from None
    Path(out).write_bytes(buf.getvalue())
    return {"pages": len(r.pages), "field": name, "signed": 1, "timestamped": bool(timestamper)}


def _sig_fields(r) -> list:
    root = r.trailer["/Root"]
    form = root.get("/AcroForm")
    if form is None:
        return []
    out, stack = [], list(reversed(list(form.get_object().get("/Fields") or [])))
    while stack:
        f = stack.pop().get_object()
        kids = f.get("/Kids")
        if kids is not None and f.get("/FT") is None:
            stack += list(reversed(list(kids)))
            continue
        if f.get("/FT") == "/Sig":
            out.append(f)
    return out


def _annots(page) -> tuple[list, dict]:
    notes, widgets = [], {}
    for ref in page.get("/Annots") or []:
        a = ref.get_object()
        if a.get("/Subtype") == "/Widget":
            node = a if "/T" in a else (a.get("/Parent").get_object() if a.get("/Parent") is not None else a)
            widgets[str(node.get("/T"))] = (str(node.get("/V")), str(node.get("/FT")))
        else:
            notes.append((str(a.get("/Subtype")), str(a.get("/NM") or ""), str(a.get("/Rect")), str(a.get("/Contents") or "")))
    return notes, widgets


def _changes(data: bytes, end: int) -> set[str]:
    from pypdf import PdfReader

    old, new = PdfReader(io.BytesIO(data[:end]), strict=False), PdfReader(io.BytesIO(data), strict=False)
    cats: set[str] = set()
    if len(old.pages) != len(new.pages):
        return {"pages"}
    for po, pn in zip(old.pages, new.pages):
        co, cn = po.get_contents(), pn.get_contents()
        if (co.get_data() if co is not None else b"") != (cn.get_data() if cn is not None else b""):
            cats.add("content")
        for key in ("/MediaBox", "/CropBox", "/Rotate"):
            if str(po.get(key)) != str(pn.get(key)):
                cats.add("pages")
        ro, rn = po.get("/Resources"), pn.get("/Resources")
        ro, rn = (ro.get_object() if ro is not None else {}), (rn.get_object() if rn is not None else {})
        for key in ("/XObject", "/Font"):
            a, b = ro.get(key), rn.get(key)
            if sorted((a.get_object() if a is not None else {}).keys()) != sorted((b.get_object() if b is not None else {}).keys()):
                cats.add("content")
        no, wo = _annots(po)
        nn, wn = _annots(pn)
        if no != nn:
            cats.add("comments")
        for name, (v, ft) in wn.items():
            before = wo.get(name)
            if before is None:
                cats.add("newsig" if ft == "/Sig" else "fields")
            elif before[0] != v:
                cats.add("sign" if ft == "/Sig" else "forms")
        if set(wo) - set(wn):
            cats.add("fields")
    return cats


CHANGE_WORDS = {"content": "the page content", "pages": "pages", "fields": "form fields", "comments": "comments", "forms": "form values", "sign": "signatures",
                "newsig": "a new signature field"}


def _docmdp(sd) -> int:
    for ref in sd.get("/Reference") or []:
        ref = ref.get_object()
        if str(ref.get("/TransformMethod")) == "/DocMDP":
            params = ref.get("/TransformParams")
            try:
                return int(params.get_object().get("/P", 2)) if params is not None else 2
            except (TypeError, ValueError):
                return 2
    return 0


def _later(data: bytes, end: int, level: int) -> tuple[bool, str]:
    cats = _changes(data, end)
    allowed = {1: set(), 2: {"forms", "sign"}, 3: {"forms", "sign", "comments"}}.get(level, {"forms", "sign", "comments", "newsig"})
    if not cats:
        return True, "The document has not been changed since this signature was applied, apart from saving."
    names = ", ".join(CHANGE_WORDS[c] for c in sorted(cats))
    if cats <= allowed:
        return True, f"Changed after this signature: {names}. That is allowed, and what was signed is unchanged."
    return False, f"Changed after this signature: {names}. {'The signer did not allow that' if level else 'That is more than filling, signing or commenting'}."


def _sentences(st, trusted_known: bool, later: tuple[bool, str] | None = None) -> tuple[str, list[str]]:
    from pyhanko.sign.diff_analysis.policy_api import ModificationLevel
    from pyhanko.sign.validation.status import SignatureCoverageLevel

    says = []
    if not st.intact:
        return "invalid", ["The document was changed after it was signed, so this signature no longer matches what is on the page."]
    if not st.valid:
        return "invalid", ["The signature itself is damaged or uses an algorithm formpdf does not accept."]
    mod = getattr(st, "modification_level", None)
    docmdp_ok = getattr(st, "docmdp_ok", True)
    if later is not None and st.coverage != SignatureCoverageLevel.ENTIRE_FILE and mod == ModificationLevel.OTHER:
        ok, sentence = later
        if not ok:
            return "invalid", [sentence]
        says.append(sentence)
    elif docmdp_ok is False:
        return "invalid", ["The document was changed after signing in a way the signer did not allow."]
    elif st.coverage == SignatureCoverageLevel.ENTIRE_FILE:
        says.append("The document has not been changed since this signature was applied.")
    elif mod in (ModificationLevel.FORM_FILLING, ModificationLevel.ANNOTATIONS, ModificationLevel.LTA_UPDATES):
        what = {ModificationLevel.FORM_FILLING: "Form filling or signing", ModificationLevel.ANNOTATIONS: "Comments, form filling or signing",
                ModificationLevel.LTA_UPDATES: "Validation information"}[mod]
        says.append(f"{what} happened after this signature; the signer allowed that, and what they signed is unchanged.")
    else:
        return "invalid", ["The document was changed after it was signed in ways formpdf cannot confirm were allowed."]
    verdict = "valid" if st.trusted else "unknown"
    if st.trusted:
        says.append("The signer's certificate is one you trust.")
    elif trusted_known:
        says.append("The signer's certificate could not be checked against the ones you trust.")
    else:
        says.append("formpdf does not know whether to trust the signer's certificate. If you are sure it belongs to them, choose Trust certificate.")
    ts = getattr(st, "timestamp_validity", None)
    if ts is not None:
        says.append(f"A timestamp authority confirms it was signed by {_when(ts.timestamp)}.")
    elif getattr(st, "signer_reported_dt", None):
        says.append(f"Signed at {_when(st.signer_reported_dt)} by the signer's own clock.")
    return verdict, says


def signatures(path, *, args: dict | None = None, pages=None, passwords: list[str] | None = None):
    from cryptography import x509
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    data = Path(path).read_bytes()
    r = PdfFileReader(io.BytesIO(data), strict=False)
    if r.encrypted:
        for pw in [*(passwords or []), ""]:
            try:
                r.decrypt(pw)
                break
            except Exception:
                continue
    roots = _trust_roots()
    out = []
    for k, s in enumerate(r.embedded_signatures):
        entry = {"index": k, "field": s.field_name, "verdict": "invalid", "says": [], "page": None}
        sd = s.sig_object
        br = list(sd.get("/ByteRange") or [])
        end = int(br[2]) + int(br[3]) if len(br) == 4 else 0
        try:
            ctx = ValidationContext(trust_roots=roots, allow_fetching=False, revocation_mode="soft-fail")
            st = validate_pdf_signature(s, ctx)
            later = None
            if end and end < len(data.rstrip()) - 2:
                try:
                    later = _later(data, end, _docmdp(sd))
                except Exception:
                    later = None
            entry["verdict"], entry["says"] = _sentences(st, bool(roots), later)
            cert = x509.load_der_x509_certificate(st.signing_cert.dump())
            entry["signer"] = _cert_info(cert)
            entry["time"] = _when(getattr(st, "signer_reported_dt", None))
            entry["timestamped"] = getattr(st, "timestamp_validity", None) is not None
        except Exception as e:
            entry["says"] = [f"formpdf could not read this signature ({str(e)[:120]})."]
        entry["reason"] = str(sd.get("/Reason") or "")
        entry["location"] = str(sd.get("/Location") or "")
        entry["certified"] = _docmdp(sd)
        entry["end"] = end
        entry["coversAll"] = entry["end"] >= len(data.rstrip()) - 2
        out.append(entry)
    plain = core.reader(path, passwords)
    empty = []
    for f in _sig_fields(plain):
        if f.get("/V") is None:
            empty.append({"field": str(f.get("/T") or ""), "tooltip": str(f.get("/TU") or "")})
    req = _request_states(_request_info(plain), out)
    lines = [f"{e['field']}: {e['verdict']} · {(e.get('signer') or {}).get('name', 'unknown signer')} · {' '.join(e['says'])}" for e in out]
    lines += [f"{e['field']}: empty signature field" for e in empty]
    if req:
        lines += [f"Request: {p['order']}. {p['name']} ({p['field']}) · {p['state']}" for p in req["signers"]]
    return ("\n".join(lines) or "No signatures."), {"signatures": out, "empty": empty, "request": req}


REQ_KEY = "/FormpdfRequest"


def _request_info(r) -> dict | None:
    raw = r.trailer["/Root"].get(REQ_KEY)
    if raw is None:
        return None
    try:
        return json.loads(str(raw))
    except ValueError:
        return None


def request(src, out, *, args: dict, pages=None, passwords: list[str] | None = None) -> dict:
    from pypdf.generic import NameObject, TextStringObject

    people = [p for p in (args or {}).get("signers") or [] if isinstance(p, dict) and str(p.get("name") or "").strip()]
    if not people:
        raise ValueError("Add at least one signer with a name")
    if len(people) > 20:
        raise ValueError("A request can have at most 20 signers")
    r = core.reader(src, passwords)
    empty = [f for f in _sig_fields(r) if f.get("/V") is None]
    if len(empty) < len(people):
        raise ValueError(f"This PDF has {len(empty)} empty signature field{'s' if len(empty) != 1 else ''} for {len(people)} signers. "
                         "Add one for each signer in Prepare form > Signature.")
    w = core.writer(src, passwords)
    plan = []
    wanted = {str(f.get("/T")) for f in empty[:len(people)]}
    fields = {}
    for p in w.pages:
        for ref in p.get("/Annots") or []:
            a = ref.get_object()
            node = a if "/T" in a else (a.get("/Parent").get_object() if a.get("/Parent") is not None else a)
            if str(node.get("/T")) in wanted:
                fields[str(node.get("/T"))] = node
    order = [str(f.get("/T")) for f in empty[:len(people)]]
    for k, (person, name) in enumerate(zip(people, order)):
        who = re.sub(r"\s+", " ", str(person["name"])).strip()[:120]
        email = str(person.get("email") or "").strip()[:200]
        node = fields.get(name)
        if node is not None:
            node[NameObject("/TU")] = TextStringObject(f"Signature {k + 1} of {len(people)}: {who}")
        plan.append({"order": k + 1, "name": who, "email": email, "field": name})
    info = {"v": 1, "signers": plan, "created": _when(datetime.datetime.now(datetime.timezone.utc)), "message": str(args.get("message") or "")[:2000]}
    w._root_object[NameObject(REQ_KEY)] = TextStringObject(json.dumps(info, ensure_ascii=False))
    touched = set()
    core.keep_pages(w, touched)
    with open(out, "wb") as fh:
        w.write(fh)
    return {"pages": len(w.pages), "signers": len(plan)}


def _request_states(info: dict | None, sigs: list[dict]) -> dict | None:
    if info is None:
        return None
    by_field = {s["field"]: s for s in sigs}
    nxt = None
    for p in info.get("signers") or []:
        s = by_field.get(p.get("field"))
        p["state"] = "signed" if s else "waiting"
        if s:
            p["verdict"] = s["verdict"]
            p["signedBy"] = (s.get("signer") or {}).get("name", "")
            p["time"] = s.get("time", "")
        elif nxt is None:
            nxt = p
            p["state"] = "next"
    info["next"] = nxt
    info["done"] = nxt is None
    return info


def join_copy(current: bytes, returned: bytes) -> bytes:
    if returned.startswith(current.rstrip()) and len(returned) > len(current):
        return returned
    if current.startswith(returned.rstrip()):
        raise ValueError("This copy is older than the open PDF; nothing new to bring in")
    raise ValueError("This copy was not signed from the open version (it was signed in parallel or changed elsewhere), so its signature "
                     "cannot be joined to the others. Keep it as a separate file, and send signers the latest signed copy in turn.")


def revision(path, index: int, passwords: list[str] | None = None) -> bytes:
    _, got = signatures(path, passwords=passwords)
    sigs = got["signatures"]
    if not 0 <= index < len(sigs) or not sigs[index]["end"]:
        raise ValueError("There is no such signature")
    return Path(path).read_bytes()[:sigs[index]["end"]]


actions.register(actions.Action("signatures", "read", "Check signatures", words=("validate signature", "digital signature", "certificate", "signed"),
                                run=signatures))
actions.register(actions.Action("sign", "change", "Sign with a digital ID", "signed", ("certificate signature", "digital id", "pades", "certify"),
                                run=sign))
actions.register(actions.Action("request_signatures", "change", "Request signatures", "request", ("send for signature", "signers", "sign in order"),
                                run=request))
