"""Polite, safe fetching of one Source (plan 4.5, `fetch()`).

Every hop (including robots.txt and each redirect) passes, in order: the host policy, robots.txt
under the stricter status rules, Content Signals, the address guard and the per-host limiter.
Requests are conditional, identify the crawler, and never log in, post forms, solve CAPTCHAs,
rotate proxies or hide. Bot challenges are reported as `blocked` and never retried or evaded.
Bodies stream with decoded-byte caps, so a compression bomb aborts early.

No wait inside a fetch exceeds `max_wait_seconds` (MAX_INLINE_WAIT_SECONDS by default): a longer
host spacing, Crawl-delay, Retry-After or back-off returns `deferred` with `retry_after`, and the
Worker reschedules the job.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urljoin, urlsplit

import httpx

from .config import (
    BACKOFF_START_SECONDS,
    FETCH_ATTEMPTS,
    HTML_CAP_BYTES,
    MAX_INLINE_WAIT_SECONDS,
    MAX_REDIRECTS,
    PDF_CAP_BYTES,
    PRODUCT_TOKEN,
)
from .limiter import HostHealth, HostLimiter, WaitTooLong
from .netguard import AddressGuard, BlockedAddress
from .policy import DEFAULT_POLICY, HostPolicy
from .robots import MAX_ROBOTS_BYTES, RobotsCache, RobotsRules, parse_retry_after, rules_for_status

Outcome = Literal["ok", "not_modified", "skipped", "blocked", "deferred", "failed"]
API_KINDS = frozenset({"federal_api", "ats_board"})
_REDIRECTS = frozenset({301, 302, 303, 307, 308})
# Interstitial markers that only challenge pages carry; checked on any status.
_STRONG_MARKERS = (
    b"cf-chl",
    b"challenge-platform",
    b"<title>just a moment...</title>",
    b"attention required! | cloudflare",
    b"_incapsula_resource",
    b"px-captcha",
    b"pardon our interruption",
)
# Markers a normal page may also carry (a contact form's CAPTCHA); checked only on refusals.
_REFUSAL_MARKERS = (b"g-recaptcha", b"h-captcha", b"verify you are human", b"captcha")


@dataclass
class FetchRequest:
    url: str
    source_kind: str = "official_page"
    source_id: str | None = None
    etag: str | None = None
    last_modified: str | None = None


@dataclass
class SourceCheck:
    outcome: Outcome
    reason: str | None
    requested_url: str
    final_url: str
    redirect_chain: list[str] = field(default_factory=list)
    http_status: int | None = None
    content_type: str = ""
    body: bytes | None = None
    raw_sha256: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    signals: dict[str, str] = field(default_factory=dict)
    retry_after: float | None = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def ai_input_allowed(self) -> bool:
        return self.signals.get("ai-input") != "no"

    @property
    def is_pdf(self) -> bool:
        return "pdf" in self.content_type.lower() or self.final_url.lower().split("?", 1)[0].endswith(".pdf")

    def summary(self) -> dict[str, object]:
        """What the job reports back: never the body."""
        return {
            "outcome": self.outcome,
            "reason": self.reason,
            "requestedUrl": self.requested_url,
            "finalUrl": self.final_url,
            "redirectChain": self.redirect_chain,
            "httpStatus": self.http_status,
            "contentType": self.content_type,
            "rawSha256": self.raw_sha256,
            "etag": self.etag,
            "lastModified": self.last_modified,
            "contentSignals": self.signals,
            "aiInputAllowed": self.ai_input_allowed,
            "retryAfterSeconds": self.retry_after,
            "fetchedAt": self.fetched_at.isoformat().replace("+00:00", "Z"),
        }


class BodyTooLarge(Exception):
    pass


def read_capped(resp: httpx.Response, cap: int) -> bytes:
    """Count decoded bytes and abort past the cap (a declared length is checked up front)."""
    declared = resp.headers.get("content-length")
    if declared and declared.isdigit() and resp.headers.get("content-encoding") in (None, "", "identity"):
        if int(declared) > cap:
            raise BodyTooLarge()
    chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_bytes():
        total += len(chunk)
        if total > cap:
            raise BodyTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


def read_prefix(resp: httpx.Response, cap: int) -> bytes:
    """The first `cap` decoded bytes; the stream is closed after that."""
    chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_bytes():
        chunks.append(chunk[: cap - total])
        total += len(chunks[-1])
        if total >= cap:
            break
    return b"".join(chunks)


def looks_like_bot_challenge(status: int, headers: httpx.Headers, body: bytes) -> bool:
    if (headers.get("cf-mitigated") or "").lower() == "challenge":
        return True
    head = body[:20_000].lower()
    if any(m in head for m in _STRONG_MARKERS):
        return True
    return status in (403, 429, 503) and any(m in head for m in _REFUSAL_MARKERS)


@dataclass
class _Response:
    status: int
    headers: httpx.Headers
    body: bytes


class Fetcher:
    def __init__(
        self,
        client: httpx.Client,
        *,
        policy: HostPolicy = DEFAULT_POLICY,
        guard: AddressGuard | None = None,
        robots: RobotsCache | None = None,
        limiter: HostLimiter | None = None,
        health: HostHealth | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        max_wait_seconds: float = MAX_INLINE_WAIT_SECONDS,
    ) -> None:
        self.client = client
        self.policy = policy
        self.guard = guard or AddressGuard()
        self.robots = robots or RobotsCache(self._load_robots)
        self.limiter = limiter or HostLimiter(sleep=sleep)
        self.health = health or HostHealth()
        self._sleep = sleep
        self._now = now
        self.max_wait_seconds = max_wait_seconds

    # -- robots.txt --------------------------------------------------------------------------

    def _load_robots(self, origin: str) -> RobotsRules:
        url = origin + "/robots.txt"
        now = time.time()
        for _ in range(MAX_REDIRECTS + 1):
            if not self.policy.resolve(url).fetchable:
                return RobotsRules("blocked", fetched_at=now)
            try:
                self.guard.check_host(url)
            except BlockedAddress:
                return RobotsRules("blocked", fetched_at=now)
            host = urlsplit(url).hostname or ""
            # WaitTooLong propagates to fetch(), so a host we may not touch yet is not cached
            # as unreachable.
            self.limiter.wait(host, max_wait=self.max_wait_seconds)
            try:
                with self.client.stream("GET", url) as r:
                    if r.status_code in _REDIRECTS and r.headers.get("location"):
                        url = urljoin(url, r.headers["location"])
                        continue
                    # RFC 9309: parse at least the first 500 KiB; the rest is ignored.
                    body = read_prefix(r, MAX_ROBOTS_BYTES) if 200 <= r.status_code < 300 else b""
                    retry = parse_retry_after(r.headers.get("retry-after"))
                    return rules_for_status(r.status_code, body.decode("utf-8", "replace"), PRODUCT_TOKEN, retry, now)
            except httpx.HTTPError:
                return RobotsRules("unreachable", fetched_at=now)
        return RobotsRules("unreachable", fetched_at=now)

    # -- one GET with retries ------------------------------------------------------------------

    def _get(self, url: str, headers: dict[str, str], crawl_delay: float | None, cap: int) -> _Response | SourceCheck:
        host = urlsplit(url).hostname or ""
        delay = BACKOFF_START_SECONDS
        last_reason = "network_error"
        retry_after: float | None = None
        for attempt in range(FETCH_ATTEMPTS):
            self.limiter.wait(host, crawl_delay, self.max_wait_seconds)
            try:
                with self.client.stream("GET", url, headers=headers) as r:
                    if r.status_code == 429 or r.status_code >= 500 or r.status_code == 403:
                        try:
                            peek = read_capped(r, 64 * 1024)
                        except BodyTooLarge:
                            peek = b""
                        if looks_like_bot_challenge(r.status_code, r.headers, peek):
                            return SourceCheck("blocked", "bot_protection", url, url, http_status=r.status_code)
                        if r.status_code == 403:
                            return _Response(r.status_code, r.headers, peek)
                        retry_after = parse_retry_after(r.headers.get("retry-after"))
                        last_reason = f"http_{r.status_code}"
                    else:
                        body = read_capped(r, cap)
                        self.health.record_success(host)
                        return _Response(r.status_code, r.headers, body)
            except BodyTooLarge:
                return SourceCheck("failed", "body_too_large", url, url)
            except httpx.HTTPError:
                last_reason = "network_error"
                retry_after = None
            if attempt + 1 < FETCH_ATTEMPTS:
                wait = max(delay, retry_after or 0.0)
                if wait > self.max_wait_seconds:
                    # Too long to sleep in a job: the Worker retries after `wait` instead.
                    self.health.record_failure(host)
                    return SourceCheck("deferred", last_reason, url, url, retry_after=wait)
                self._sleep(wait)
                delay *= 2
        self.health.record_failure(host)
        return SourceCheck("deferred", last_reason, url, url, retry_after=max(delay, retry_after or 0.0))

    # -- the fetch -------------------------------------------------------------------------------

    def fetch(self, req: FetchRequest) -> SourceCheck:
        try:
            return self._fetch(req)
        except WaitTooLong as exc:
            # Host spacing or Crawl-delay needs a longer wait than a job may sleep.
            return SourceCheck(
                "deferred", "host_spacing", req.url, req.url, retry_after=exc.seconds, fetched_at=self._now()
            )

    def _fetch(self, req: FetchRequest) -> SourceCheck:
        url = req.url
        chain: list[str] = []

        def done(check: SourceCheck) -> SourceCheck:
            check.requested_url = req.url
            check.redirect_chain = chain
            check.final_url = url
            check.fetched_at = self._now()
            return check

        for _hop in range(MAX_REDIRECTS + 1):
            decision = self.policy.resolve(url)
            if not decision.fetchable:
                return done(SourceCheck("skipped", f"host_policy:{decision.policy}", url, url))
            if decision.policy == "api_only" and req.source_kind not in API_KINDS:
                return done(SourceCheck("skipped", "host_policy:api_only", url, url))
            try:
                self.guard.check_url(url)
            except BlockedAddress as exc:
                return done(SourceCheck("blocked", f"address:{exc.reason}", url, url))
            parts = urlsplit(url)
            host = parts.hostname or ""
            paused = self.health.paused_until(host)
            if paused is not None:
                return done(SourceCheck("deferred", "host_paused", url, url, retry_after=paused - time.time()))
            robots = self.robots.get(f"{parts.scheme}://{parts.netloc}")
            if robots.unreachable:
                return done(SourceCheck("deferred", "robots_unreachable", url, url, retry_after=robots.retry_after))
            if robots.state == "blocked":
                return done(SourceCheck("blocked", "robots_status", url, url))
            if not robots.allowed(url):
                return done(SourceCheck("blocked", "robots", url, url))
            signals = robots.signal_map
            if signals.get("search") == "no":
                # Novus shows links and short excerpts, so search=no makes the host manual-only.
                return done(SourceCheck("skipped", "content_signal_search", url, url, signals=signals))
            try:
                self.guard.check_host(url)
            except BlockedAddress as exc:
                return done(SourceCheck("blocked", f"address:{exc.reason}", url, url))

            headers: dict[str, str] = {}
            if not chain:  # validators belong to the Source's own URL, not to a redirect target
                if req.etag:
                    headers["If-None-Match"] = req.etag
                if req.last_modified:
                    headers["If-Modified-Since"] = req.last_modified
            cap = PDF_CAP_BYTES if req.source_kind == "official_pdf" or url.lower().endswith(".pdf") else HTML_CAP_BYTES
            got = self._get(url, headers, robots.crawl_delay, cap)
            if isinstance(got, SourceCheck):
                got.signals = signals
                return done(got)
            if got.status in _REDIRECTS:
                location = got.headers.get("location")
                if not location:
                    return done(SourceCheck("failed", "redirect_without_location", url, url, http_status=got.status))
                chain.append(url)
                url = urljoin(url, location)
                continue
            if got.status == 304:
                return done(SourceCheck("not_modified", None, url, url, http_status=304, signals=signals))
            content_type = got.headers.get("content-type", "")
            if looks_like_bot_challenge(got.status, got.headers, got.body):
                return done(SourceCheck("blocked", "bot_protection", url, url, http_status=got.status, signals=signals))
            if got.status != 200:
                return done(
                    SourceCheck("failed", f"http_{got.status}", url, url, http_status=got.status, content_type=content_type, signals=signals)
                )
            if "pdf" not in content_type.lower() and len(got.body) > HTML_CAP_BYTES:
                return done(SourceCheck("failed", "body_too_large", url, url, http_status=200))
            return done(
                SourceCheck(
                    "ok",
                    None,
                    url,
                    url,
                    http_status=200,
                    content_type=content_type,
                    body=got.body,
                    raw_sha256=hashlib.sha256(got.body).hexdigest(),
                    etag=got.headers.get("etag"),
                    last_modified=got.headers.get("last-modified"),
                    signals=signals,
                )
            )
        return done(SourceCheck("failed", "too_many_redirects", url, url))
