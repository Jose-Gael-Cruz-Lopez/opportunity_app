"""Error types for DocIntel.

Every error carries a short machine code. Messages never include document
text, because exceptions end up in logs and error trackers.
"""

from __future__ import annotations

from typing import Literal

ErrorCode = Literal[
    "limit_exceeded",
    "parse_failed",
    "encrypted",
    "not_a_pdf",
    "isolation_violation",
    "engine_unavailable",
    "network_denied",
    "deny_list_hit",
]


class DocIntelError(Exception):
    """Base error. `code` is safe to log; the message is a fixed phrase."""

    code: ErrorCode = "parse_failed"

    def __init__(self, code: ErrorCode | None = None, detail: str = "") -> None:
        if code is not None:
            self.code = code
        # `detail` must be a fixed, content-free phrase (sizes and counts are fine).
        super().__init__(f"{self.code}: {detail}" if detail else self.code)


class LimitExceeded(DocIntelError):
    code: ErrorCode = "limit_exceeded"


class ParseFailed(DocIntelError):
    code: ErrorCode = "parse_failed"


class IsolationViolation(DocIntelError):
    """Raised when a document would be processed outside its required runtime."""

    code: ErrorCode = "isolation_violation"


class EngineUnavailable(DocIntelError):
    """An optional OCR engine is not installed in this image."""

    code: ErrorCode = "engine_unavailable"


class NetworkDenied(DocIntelError):
    code: ErrorCode = "network_denied"
