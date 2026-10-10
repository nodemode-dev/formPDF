import asyncio

from app.core import ids


def windows() -> list:
    from app.routers.live import CLIENTS

    found = [c for c in CLIENTS.values() if c.kind == "window"]
    found.sort(key=lambda c: (c.doc is not None, bool(c.agents), c.seen), reverse=True)
    return found


def window_connected() -> bool:
    return bool(windows())


def window_doc() -> dict | None:
    for c in windows():
        if c.doc:
            return c.doc
    return None


async def window_call(name: str, args: dict, timeout: float = 60) -> dict | None:
    from app.routers.live import CLIENTS, TOOL_RESULTS

    for client in windows():
        rid = ids.short("t", 10)
        fut = asyncio.get_running_loop().create_future()
        TOOL_RESULTS[rid] = fut
        try:
            try:
                await client.send({"t": "tool", "id": rid, "name": name, "args": args})
            except Exception:
                CLIENTS.pop(client.id, None)
                continue
            try:
                out = await asyncio.wait_for(fut, timeout)
            except asyncio.TimeoutError:
                return {"content": [{"type": "text", "text": f"The formpdf window did not answer {name} within {int(timeout)} seconds."}], "isError": True}
            return out if isinstance(out, dict) else {"content": [{"type": "text", "text": str(out)}]}
        finally:
            TOOL_RESULTS.pop(rid, None)
    return None
