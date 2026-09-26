from __future__ import annotations

from typing import Any, Optional


class YungleError(Exception):
    """An API error. Branch on ``code``, never on the message."""

    def __init__(self, status: int, code: str, message: str, details: Optional[dict[str, Any]] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}

    @property
    def retryable(self) -> bool:
        """Worth trying again: throttled, or the server's fault."""
        return self.status == 429 or self.status >= 500

    @property
    def retry_after_seconds(self) -> Optional[float]:
        value = self.details.get("retryAfterSeconds")
        return float(value) if isinstance(value, (int, float)) else None

    def __repr__(self) -> str:
        return f"YungleError(status={self.status}, code={self.code!r}, message={self.message!r})"
