import hashlib
import secrets
import string

_ALPHABET = string.ascii_lowercase + string.digits


def short(prefix: str, n: int = 6) -> str:
    return prefix + "".join(secrets.choice(_ALPHABET) for _ in range(n))


def media_id(data: bytes, kind: str) -> str:
    prefix = {"image": "img_"}.get(kind, "doc_")
    return prefix + hashlib.sha256(data).hexdigest()[:10]
