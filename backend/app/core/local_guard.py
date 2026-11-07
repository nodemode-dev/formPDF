from urllib.parse import urlsplit

LOOPBACK = {"127.0.0.1", "localhost", "::1"}
EXTENSION_FILES = "/api/extensions/files/"


def _host_of(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):
        return value[1:].split("]", 1)[0]
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _origin_key(value: str) -> tuple[str, str, int | None] | None:
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    if port is None:
        port = {"http": 80, "https": 443}.get(parts.scheme)
    return parts.scheme.lower(), parts.hostname.lower(), port


class LocalGuard:
    def __init__(self, app, origins: list[str]) -> None:
        self.app = app
        self.allowed = {key for key in (_origin_key(o) for o in origins) if key is not None}

    def _permitted(self, headers: dict[str, str]) -> bool:
        host = headers.get("host", "")
        if _host_of(host) not in LOOPBACK:
            return False
        origin = headers.get("origin")
        if origin is None:
            return headers.get("sec-fetch-site", "").strip().lower() != "cross-site"
        key = _origin_key(origin)
        if key is None:
            return False
        if key in self.allowed:
            return True
        own = _origin_key(f"{key[0]}://{host}")
        return key[0] == "http" and own is not None and own == key

    @staticmethod
    def _extension_file(scope, headers: dict[str, str]) -> bool:
        return (scope["type"] == "http" and scope.get("method") in ("GET", "HEAD") and str(scope.get("path", "")).startswith(EXTENSION_FILES)
                and "/.." not in str(scope.get("path", "")) and _host_of(headers.get("host", "")) in LOOPBACK)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if self._permitted(headers) or self._extension_file(scope, headers):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = b'{"detail":"formpdf answers this computer\'s own window and agents only"}'
        await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
