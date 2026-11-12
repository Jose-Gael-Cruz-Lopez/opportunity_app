"""Pipeline settings, read from the environment (Modal secrets in production, a shell locally).

No secret has a default. The user agent and From address identify the crawler and its opt-out
page, never a person.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

PRODUCT_TOKEN = "NovusBot"
HTML_CAP_BYTES = 5 * 1024 * 1024
PDF_CAP_BYTES = 32 * 1024 * 1024
MAX_REDIRECTS = 5
FETCH_ATTEMPTS = 3
BACKOFF_START_SECONDS = 30.0
# Longest single wait inside a job (host spacing, Crawl-delay, Retry-After, back-off). Anything
# longer becomes a `deferred` result with retry_after, so the Worker reschedules the job instead
# of a Modal run sleeping past its timeout with leased jobs stranded.
MAX_INLINE_WAIT_SECONDS = 5.0
# Snapshots up to this size travel inline (base64) in POST /internal/v1/snapshots; larger ones
# use the raw-object PUT first. The contract allows 14 MB of base64 (about 10.5 MB of bytes).
INLINE_SNAPSHOT_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class PipelineConfig:
    user_agent: str
    from_address: str
    internal_base_url: str | None
    internal_key_id: str | None
    internal_key_secret: str | None
    access_client_id: str | None
    access_client_secret: str | None
    worker_name: str
    # The `clock` key family: the only one (besides break-glass) allowed to call tickCatchUp.
    clock_key_id: str | None = None
    clock_key_secret: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> PipelineConfig:
        e = os.environ if env is None else env
        bot_page = e.get("NOVUS_BOT_PAGE_URL", "https://novus.example/bot")
        return cls(
            user_agent=f"{PRODUCT_TOKEN}/1.0 (+{bot_page})",
            from_address=e.get("NOVUS_BOT_FROM", "crawler@novus.example"),
            internal_base_url=e.get("NOVUS_INTERNAL_BASE_URL"),
            internal_key_id=e.get("NOVUS_INTERNAL_KEY_ID"),
            internal_key_secret=e.get("NOVUS_INTERNAL_KEY_SECRET"),
            access_client_id=e.get("NOVUS_ACCESS_CLIENT_ID"),
            access_client_secret=e.get("NOVUS_ACCESS_CLIENT_SECRET"),
            worker_name=e.get("NOVUS_WORKER_NAME", "pipeline-local"),
            clock_key_id=e.get("NOVUS_INTERNAL_CLOCK_KEY_ID") or None,
            clock_key_secret=e.get("NOVUS_INTERNAL_CLOCK_KEY_SECRET") or None,
        )

    @property
    def internal_configured(self) -> bool:
        return bool(self.internal_base_url and self.internal_key_id and self.internal_key_secret)

    @property
    def clock_configured(self) -> bool:
        return bool(self.internal_base_url and self.clock_key_id and self.clock_key_secret)
