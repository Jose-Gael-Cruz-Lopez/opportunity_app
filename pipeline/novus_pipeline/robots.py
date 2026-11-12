"""robots.txt under RFC 9309 with stricter status rules, plus Cloudflare Content Signals (plan 4.5).

Status rules (stricter than the RFC):
- 2xx: parse and obey; cached up to 24 hours.
- 401, 403: blocked, so the host falls back to manual evidence.
- 429 and 5xx (and network errors): unreachable, treated as fully disallowed, retried after any
  Retry-After and never cached as allow-all.
- other 4xx: allow-all, cached for at most 24 hours.

Content-Signal lines are read inside the matching user-agent group: `ai-input=no` keeps the host's
pages away from every model, `search=no` makes the host manual-only with no excerpts.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, MutableMapping
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import unquote, urlsplit

MAX_ROBOTS_BYTES = 500 * 1024  # RFC 9309 asks parsers to handle at least 500 KiB
CACHE_SECONDS = 24 * 3600
UNREACHABLE_RETRY_SECONDS = 3600

RobotsState = Literal["parsed", "allow_all", "blocked", "unreachable"]


@dataclass
class _Group:
    agents: list[str] = field(default_factory=list)
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow, pattern)
    crawl_delay: float | None = None
    signals: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RobotsRules:
    state: RobotsState
    rules: tuple[tuple[bool, str], ...] = ()
    crawl_delay: float | None = None
    signals: tuple[tuple[str, str], ...] = ()
    retry_after: float | None = None
    fetched_at: float = 0.0

    @property
    def unreachable(self) -> bool:
        return self.state == "unreachable"

    @property
    def signal_map(self) -> dict[str, str]:
        return dict(self.signals)

    def allowed(self, url: str) -> bool:
        if self.state == "allow_all":
            return True
        if self.state in ("blocked", "unreachable"):
            return False
        parts = urlsplit(url)
        path = parts.path or "/"
        if path == "/robots.txt":
            return True
        target = _canon_path(path + (f"?{parts.query}" if parts.query else ""))
        best: tuple[int, bool] | None = None  # (pattern length, allow)
        for allow, pattern in self.rules:
            if pattern and _matches(pattern, target):
                key = (len(pattern), allow)  # longest match wins; on a tie, allow wins
                if best is None or key > best:
                    best = key
        return True if best is None else best[1]

    def to_cache(self) -> dict[str, object]:
        return {
            "state": self.state,
            "rules": [list(r) for r in self.rules],
            "crawl_delay": self.crawl_delay,
            "signals": [list(s) for s in self.signals],
            "retry_after": self.retry_after,
            "fetched_at": self.fetched_at,
        }

    @classmethod
    def from_cache(cls, data: dict[str, object]) -> RobotsRules:
        return cls(
            state=data["state"],  # type: ignore[arg-type]
            rules=tuple((bool(a), str(p)) for a, p in data.get("rules", [])),  # type: ignore[union-attr]
            crawl_delay=data.get("crawl_delay"),  # type: ignore[arg-type]
            signals=tuple((str(k), str(v)) for k, v in data.get("signals", [])),  # type: ignore[union-attr]
            retry_after=data.get("retry_after"),  # type: ignore[arg-type]
            fetched_at=float(data.get("fetched_at", 0.0)),  # type: ignore[arg-type]
        )


def _canon_path(path: str) -> str:
    # Decode percent-escapes of unreserved characters only, so "/a%2Fb" stays distinct from "/a/b".
    return re.sub(r"%([0-9A-Fa-f]{2})", lambda m: _decode_unreserved(m.group(0)), path)


def _decode_unreserved(esc: str) -> str:
    ch = unquote(esc)
    return ch if re.fullmatch(r"[A-Za-z0-9._~-]", ch) else esc.upper()


def _matches(pattern: str, path: str) -> bool:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    regex = "".join(".*" if c == "*" else re.escape(c) for c in _canon_path(body))
    return re.match(regex + ("$" if anchored else ""), path) is not None


def _parse_signals(value: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in value.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip().lower()
    return out


def parse_robots(text: str, product_token: str) -> RobotsRules:
    groups: list[_Group] = []
    current: _Group | None = None
    last_was_agent = False
    for raw in text[:MAX_ROBOTS_BYTES].splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (s.strip() for s in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if current is None or not last_was_agent:
                current = _Group()
                groups.append(current)
            current.agents.append(value.lower())
            last_was_agent = True
            continue
        last_was_agent = False
        if current is None:
            continue
        if key in ("allow", "disallow"):
            current.rules.append((key == "allow", value))
        elif key == "crawl-delay":
            try:
                current.crawl_delay = float(value)
            except ValueError:
                pass
        elif key == "content-signal":
            current.signals.update(_parse_signals(value))
    token = product_token.lower()
    mine = [g for g in groups if token in g.agents]
    chosen = mine or [g for g in groups if "*" in g.agents]
    rules: list[tuple[bool, str]] = []
    signals: dict[str, str] = {}
    delay: float | None = None
    for g in chosen:  # RFC 9309: groups for the same agent are combined
        rules.extend(g.rules)
        signals.update(g.signals)
        if g.crawl_delay is not None:
            delay = max(delay or 0.0, g.crawl_delay)
    return RobotsRules("parsed", tuple(rules), delay, tuple(sorted(signals.items())), fetched_at=time.time())


def rules_for_status(status: int, body: str, product_token: str, retry_after: float | None, now: float) -> RobotsRules:
    if 200 <= status < 300:
        parsed = parse_robots(body, product_token)
        return RobotsRules(parsed.state, parsed.rules, parsed.crawl_delay, parsed.signals, fetched_at=now)
    if status in (401, 403):
        return RobotsRules("blocked", fetched_at=now)
    if status == 429 or status >= 500:
        return RobotsRules("unreachable", retry_after=retry_after, fetched_at=now)
    return RobotsRules("allow_all", fetched_at=now)


class RobotsCache:
    """Per-origin cache in any mapping (a Modal Dict in production, a dict on a laptop)."""

    def __init__(
        self,
        loader: Callable[[str], RobotsRules],
        store: MutableMapping[str, dict[str, object]] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._loader = loader
        self._store: MutableMapping[str, dict[str, object]] = store if store is not None else {}
        self._clock = clock

    def get(self, origin: str) -> RobotsRules:
        now = self._clock()
        cached = self._store.get(origin)
        if cached is not None:
            rules = RobotsRules.from_cache(cached)
            ttl = (rules.retry_after or UNREACHABLE_RETRY_SECONDS) if rules.unreachable else CACHE_SECONDS
            if now - rules.fetched_at < ttl:
                return rules
        rules = self._loader(origin)
        self._store[origin] = rules.to_cache()
        return rules


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """Seconds from a Retry-After header (delta-seconds or HTTP date)."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    from email.utils import parsedate_to_datetime

    try:
        when = parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0.0, when - (now if now is not None else time.time()))
