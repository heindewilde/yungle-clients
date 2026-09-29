from __future__ import annotations

import math
import time
from email.utils import parsedate_to_datetime
from typing import Any, Optional


class YungleError(Exception):
    """An API error. Branch on ``code``, never on the message."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Optional[dict[str, Any]] = None,
        docs: Optional[str] = None,
        retry_after_header: Optional[float] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}
        #: Where ``code`` is explained, with what to do about it. None on older servers.
        self.docs = docs
        self._retry_after_header = retry_after_header

    @property
    def retryable(self) -> bool:
        """Worth trying again: throttled, or the server's fault."""
        return self.status == 429 or self.status >= 500

    @property
    def retry_after_seconds(self) -> Optional[float]:
        """Seconds to wait: ``details.retryAfterSeconds``, else the ``Retry-After`` header.

        The header matters on its own — the monthly-allowance 429 states its
        wait (an hour) only there.
        """
        value = self.details.get("retryAfterSeconds")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        return self._retry_after_header

    def __repr__(self) -> str:
        return f"YungleError(status={self.status}, code={self.code!r}, message={self.message!r})"


def parse_retry_after(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """``Retry-After`` as delay-seconds or an HTTP-date (RFC 9110 §10.2.3); anything else is None."""
    if value is None:
        return None
    v = value.strip()
    if v.isdigit():
        return float(v)
    try:
        at = parsedate_to_datetime(v).timestamp()
    except (TypeError, ValueError, IndexError):
        return None
    seconds = math.ceil(at - (time.time() if now is None else now))
    return float(seconds) if seconds >= 0 else None
