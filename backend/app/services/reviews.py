import threading

from app.services.pdf import annot, docs

RESOLVED = ("accepted", "rejected", "completed", "cancelled")
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _passwords(doc_id: str) -> list[str]:
    prot = docs.meta(doc_id).get("protect") or {}
    return [p for p in (prot.get("owner"), prot.get("password")) if p]


def summary(doc_id: str) -> dict:
    path = docs.path_of(doc_id)
    stamp = path.stat().st_mtime
    with _lock:
        hit = _cache.get(doc_id)
        if hit and hit[0] == stamp:
            return hit[1]
    try:
        items = annot.comments(path, _passwords(doc_id), limit=5000)
        error = ""
    except Exception as e:
        items, error = [], f"{type(e).__name__}: {e}"[:200]
    people: dict[str, dict] = {}
    last = ""
    resolved = 0
    replies = 0

    def seen(name: str, when: str, kind: str) -> None:
        nonlocal last
        p = people.setdefault(name or "Unknown", {"name": name or "Unknown", "comments": 0, "replies": 0, "last": ""})
        p[kind] += 1
        p["last"] = max(p["last"], when or "")
        last = max(last, when or "")

    for c in items:
        seen(c.get("author", ""), c.get("date", ""), "comments")
        for r in c.get("replies") or []:
            seen(r.get("author", ""), r.get("date", ""), "replies")
            replies += 1
        if c.get("status") in RESOLVED:
            resolved += 1
    out = {"comments": len(items), "replies": replies, "open": len(items) - resolved, "resolved": resolved, "last": last,
           "reviewers": sorted(people.values(), key=lambda p: (-p["comments"] - p["replies"], p["name"].lower())), "error": error,
           "pages": sorted({c["page"] for c in items})[:50]}
    with _lock:
        _cache[doc_id] = (stamp, out)
    return out


def all_reviews() -> list[dict]:
    rows = []
    for entry in docs.recent():
        s = summary(entry["id"])
        if not s["comments"]:
            continue
        rows.append({"key": entry.get("key"), "id": entry["id"], "name": entry.get("name", ""), "path": entry.get("path", ""),
                     "opened": entry.get("opened", 0), **s})
    rows.sort(key=lambda r: (r["last"] or "", r["opened"]), reverse=True)
    return rows
