import asyncio
import time

from fastapi import APIRouter, HTTPException

from app.services import ai
from app.services.pdf import docs

router = APIRouter()


def _pw(doc_id: str) -> list[str]:
    prot = docs.meta(doc_id).get("protect") or {}
    return [p for p in (prot.get("owner"), prot.get("password")) if p]


@router.get("/ai/settings")
async def get_settings() -> dict:
    return ai.settings()


@router.post("/ai/settings")
async def set_settings(body: dict) -> dict:
    try:
        return await asyncio.to_thread(ai.save_settings, body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/ai/test")
async def test() -> dict:
    started = time.time()
    try:
        text = await asyncio.to_thread(ai.chat, "Reply with the single word: ready", system="You are a connection test.", max_tokens=20)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True, "text": text[:200], "ms": int((time.time() - started) * 1000)}


@router.post("/ai/ask")
async def ask(body: dict) -> dict:
    doc_id = str(body.get("doc") or "")
    if not docs.valid(doc_id):
        raise HTTPException(404, "Open a PDF first")
    kind = "summary" if body.get("kind") == "summary" else "ask"
    question = str(body.get("question") or "").strip()
    if kind == "ask" and not question:
        raise HTTPException(400, "Ask a question")
    if ai.settings()["provider"] == "agent":
        length = str(body.get("length") or "medium")
        text = question if kind == "ask" else f"Summarise this PDF {ai.LENGTHS.get(length, ai.LENGTHS['medium'])}, citing pages."
        item = ai.post_question(doc_id, docs.meta(doc_id).get("name") or "document.pdf", text, kind)
        return {"waiting": True, "id": item["id"]}
    fn = ai.summary if kind == "summary" else ai.ask
    try:
        _text, data = await asyncio.to_thread(fn, docs.path_of(doc_id), None, args={"question": question, "length": body.get("length")},
                                              pages=body.get("pages") or None, passwords=_pw(doc_id))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"waiting": False, **data}


@router.get("/ai/questions/{qid}")
async def question(qid: str) -> dict:
    item = ai.PENDING.get(qid)
    if item is None:
        raise HTTPException(404, "That question is no longer waiting")
    out = dict(item)
    if item.get("answer"):
        texts = await asyncio.to_thread(lambda: ai.core.extract_text(docs.path_of(item["doc"]), None, _pw(item["doc"])))
        out["citations"] = ai.citations(item["answer"], texts)
    return out


@router.delete("/ai/questions/{qid}")
async def cancel(qid: str) -> dict:
    ai.PENDING.pop(qid, None)
    return {"ok": True}
