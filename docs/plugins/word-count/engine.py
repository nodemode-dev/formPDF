import re


def register(api):
    def count(path, *, args=None, pages=None, passwords=None):
        from app.services.pdf import core

        r = core.reader(path, passwords)
        per = []
        for i, page in enumerate(r.pages, 1):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            per.append({"page": i, "words": len(re.findall(r"\w+", text))})
        total = sum(p["words"] for p in per)
        lines = [f"{total} word{'s' if total != 1 else ''} on {len(per)} page{'s' if len(per) != 1 else ''}."] + [f"Page {p['page']}: {p['words']}" for p in per[:200]]
        return "\n".join(lines), {"words": total, "pages": per}

    api.action("word_count", "read", "Count words", count, words=("word count", "how many words"))
