import base64
import binascii

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile

from app.routers.pdf import _path, _pw, _run
from app.services import pdf as pdfsvc
from app.services.pdf import docs
from app.services.pdf import sign as signsvc

router = APIRouter()
MAX_ID_BYTES = 1024 * 1024


@router.get("/identities")
async def identities() -> dict:
    return {"identities": await _run(signsvc.identities), "trusted": await _run(_trusted)}


@router.post("/identities")
async def make(body: dict) -> dict:
    return await _run(signsvc.make_identity, str(body.get("name") or ""), str(body.get("email") or ""), str(body.get("org") or ""),
                      str(body.get("password") or ""))


@router.post("/identities/import")
async def import_id(file: UploadFile = File(...), password: str = Form("")) -> dict:
    data = await file.read()
    if len(data) > MAX_ID_BYTES:
        raise HTTPException(413, "A digital ID file is never this large; choose the .p12 or .pfx file")
    return await _run(signsvc.import_identity, data, password)


@router.delete("/identities/{ident}")
async def delete(ident: str) -> dict:
    await _run(signsvc.delete_identity, ident)
    return {"ok": True}


def _trusted() -> list[dict]:
    from cryptography import x509

    out = []
    for f in sorted(signsvc._trust_dir().glob("*.der")):
        try:
            cert = x509.load_der_x509_certificate(f.read_bytes())
        except Exception:
            continue
        info = signsvc._cert_info(cert)
        out.append({k: v for k, v in info.items() if k != "der"})
    return out


@router.post("/trust")
async def trust(body: dict) -> dict:
    try:
        der = base64.b64decode(str(body.get("der") or ""), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "That is not a certificate") from None
    if not der:
        raise HTTPException(400, "That is not a certificate")
    return {"fingerprint": await _run(signsvc.trust, der)}


@router.delete("/trust/{fp}")
async def untrust(fp: str) -> dict:
    await _run(signsvc.untrust, fp)
    return {"ok": True}


@router.post("/pdf/{doc_id}/request/join")
async def join(doc_id: str, file: UploadFile = File(...)) -> dict:
    returned = await file.read()
    current = _path(doc_id).read_bytes()
    try:
        data = signsvc.join_copy(current, returned)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    new_id, out = docs.derive(doc_id)
    out.write_bytes(data)
    info = await _run(pdfsvc.info, out, _pw(doc_id))
    return {"id": new_id, "pages": info.get("pages", 0), "bytes": len(data)}


@router.get("/pdf/{doc_id}/signatures/{index}/revision")
async def signed_revision(doc_id: str, index: int) -> Response:
    data = await _run(signsvc.revision, _path(doc_id), index, _pw(doc_id))
    return Response(data, media_type="application/pdf")
