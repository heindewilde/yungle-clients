"""Verifying the ``Yungle-Signature`` header on a webhook request."""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional, Union


def verify_webhook(
    raw_body: Union[bytes, str],
    signature_header: str,
    secret: str,
    *,
    tolerance_seconds: int = 300,
    now: Optional[float] = None,
) -> bool:
    """
    True when the header signs these exact bytes with this secret, recently.

    Pass the raw request body, before any JSON parsing: re-serialising changes
    whitespace and key order, and the signature stops matching.
    """
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    try:
        parts = dict(p.split("=", 1) for p in signature_header.split(","))
        t = int(parts["t"])
        given = parts["v1"]
    except (KeyError, ValueError):
        return False
    if abs((now if now is not None else time.time()) - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, given)
