"""`next_check_at()` (plan 4.11): when a Source is fetched next.

Inputs are registry facts and s07's monitoring windows only. Commerce never enters: the function
takes no commerce argument, so priorities are identical with commerce tables full or empty.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone

HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
EXTENSION_WATCH = timedelta(hours=72)
DAILY_SLOT_UTC = time(8, 0)  # the Worker's daily 08:00 UTC slot


@dataclass(frozen=True)
class SourceFacts:
    kind: str
    policy: str
    approval: str
    tracked_deadline_within_7d: bool = False


@dataclass(frozen=True)
class CycleFacts:
    status: str  # CYCLE_STATUSES
    last_deadline_at: datetime | None = None  # latest official application deadline instant

    def in_extension_watch(self, now: datetime) -> bool:
        return self.last_deadline_at is not None and self.last_deadline_at < now <= self.last_deadline_at + EXTENSION_WATCH


@dataclass(frozen=True)
class MonitoringWindows:
    """s07's windows as half-open [start, end) instant ranges."""

    daily: Sequence[tuple[datetime, datetime]] = field(default_factory=tuple)
    every_3_days: Sequence[tuple[datetime, datetime]] = field(default_factory=tuple)

    def in_daily(self, now: datetime) -> bool:
        return any(a <= now < b for a, b in self.daily)

    def in_every_3_days(self, now: datetime) -> bool:
        return any(a <= now < b for a, b in self.every_3_days)

    def next_daily_start(self, now: datetime) -> datetime | None:
        starts = [a for a, _ in self.daily if a > now]
        return min(starts) if starts else None


def next_daily_slot(now: datetime) -> datetime:
    slot = datetime.combine(now.date(), DAILY_SLOT_UTC, tzinfo=timezone.utc)
    return slot if slot > now else slot + DAY


def next_check_at(
    src: SourceFacts,
    cyc: CycleFacts | None,
    win: MonitoringWindows,
    now: datetime,
    rng: random.Random | None = None,
) -> datetime | None:
    if src.policy not in ("allowed", "api_only") or src.approval != "approved":
        return None  # manual, link-only and pending Sources get Curator tasks instead
    if src.kind == "federal_api":
        return next_daily_slot(now)
    if src.kind == "ats_board":
        return now + (HOUR if src.tracked_deadline_within_7d else DAY)
    days = 30 if cyc is not None and cyc.status == "ended" else 7
    if win.in_daily(now) or (cyc is not None and cyc.in_extension_watch(now)):
        days = 1
    elif win.in_every_3_days(now):
        days = 3
    jitter = (rng or random).uniform(0.9, 1.1)  # spreads load; never shortens below 0.9 x
    nxt = now + timedelta(days=days * jitter)
    start = win.next_daily_start(now)
    return min(nxt, start) if start else nxt  # never skip the start of a daily window
