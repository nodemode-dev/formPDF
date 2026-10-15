import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

USAGE = """usage: formpdf cli [list [group] [text] | describe <id> | run <id> [key=value ...] [--json '{...}']]

  list                every window command (File, Edit, View, Tabs, Tools, Agents, Home, Help)
  list View zoom      commands in a group, filtered by words
  describe <id>       one command with its parameters
  run <id> k=v        run a command in the open formpdf window; values are JSON when they parse (page=3, flag=true)
"""


def base() -> str:
    url = os.environ.get("FORMPDF_ENGINE_URL")
    return url.rstrip("/") if url else f"http://127.0.0.1:{os.environ.get('FORMPDF_PORT') or 8198}"


def call(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base() + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read() or b"{}").get("detail", e.reason)
        sys.exit(f"[formpdf] {detail}")
    except urllib.error.URLError:
        sys.exit(f"[formpdf] the engine is not answering at {base()}; start formpdf first (./formpdf)")


def value(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "list":
        q = {}
        if rest:
            q["group"] = rest[0]
        if len(rest) > 1:
            q["text"] = " ".join(rest[1:])
        out = call("GET", "/api/commands" + ("?" + urllib.parse.urlencode(q) if q else ""))
        if out.get("hint"):
            print(f"[formpdf] {out['hint']}")
        for c in out["commands"]:
            keys = f"  [{', '.join(c.get('keys') or [])}]" if c.get("keys") else ""
            off = "" if c.get("enabled", True) else f"  (unavailable: {c.get('why')})"
            print(f"{c['id']:<34} {c.get('group', ''):<8} {c.get('label', '')}{keys}{off}")
        print(f"{out['count']} commands" + ("" if out.get("live") else ", window closed"))
        return 0
    if cmd == "describe" and rest:
        print(json.dumps(call("GET", f"/api/commands/{urllib.parse.quote(rest[0])}"), indent=2, ensure_ascii=False))
        return 0
    if cmd == "run" and rest:
        params: dict = {}
        args = rest[1:]
        if "--json" in args:
            i = args.index("--json")
            params.update(json.loads(args[i + 1]))
            args = args[:i] + args[i + 2:]
        for a in args:
            k, _, v = a.partition("=")
            params[k] = value(v)
        out = call("POST", f"/api/commands/{urllib.parse.quote(rest[0])}", {"params": params})
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0 if out.get("ok") else 1
    print(USAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
