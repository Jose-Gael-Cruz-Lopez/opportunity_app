"""Review-task builders: SLAs, priorities and dedupe keys (plan 4.10).

Tasks are created inside the Worker (`POST /internal/v1/review-tasks`), which keeps one open task
per dedupe key so detections merge. These helpers only shape the request; the queue order and
publish rules live in the Worker.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta

from .models import REVIEW_REASON_CODES, CreateReviewTaskInput, TaskSubject, iso_z

# Lower number = more urgent (priority 0 is "a Curator is waiting").
_REASON_PRIORITY: dict[str, int] = {
    "urgent_recheck": 1,
    "close_unconfirmed": 1,
    "quote_missing": 2,
    "value_changed": 3,
    "key_change": 4,
    "key_change_pending_draft": 3,
    "pdf_changed": 4,
    "page_changed": 6,
}
_FOUR_HOUR_REASONS = frozenset({"urgent_recheck", "close_unconfirmed"})


def is_reason_code(code: str) -> bool:
    if code in REVIEW_REASON_CODES:
        return True
    prefix, _, rest = code.partition(":")
    return prefix in ("refused", "draft_unavailable") and 1 <= len(rest) <= 40 and rest.replace("_", "").isalpha() and rest.islower()


def sla(kind: str, reasons: Sequence[str], now: datetime, *, days_to_deadline: int | None = None) -> timedelta:
    """Plan 4.10's SLA table (judgment values owned by s04)."""
    near = days_to_deadline is not None and days_to_deadline <= 7
    if kind == "cycle_update":
        if any(r in _FOUR_HOUR_REASONS for r in reasons):
            return timedelta(hours=4)
        return timedelta(hours=24 if near else 48)
    if kind == "error_report":
        return timedelta(hours=24 if days_to_deadline is not None and days_to_deadline <= 14 else 72)
    if kind in ("new_program", "possible_duplicate", "community_hint", "extraction_failed", "counts_table"):
        return timedelta(days=7)
    if kind == "source_broken":
        return timedelta(hours=72)
    if kind == "campus_deadline":
        return timedelta(hours=48)
    return timedelta(days=7)


def build_task(
    kind: str,
    subject_type: str,
    subject_id: str,
    reasons: Sequence[str],
    now: datetime,
    *,
    days_to_deadline: int | None = None,
    evidence: Sequence[str] = (),
) -> tuple[CreateReviewTaskInput, str]:
    """The create-task body and its dedupe key `{kind}:{subjectType}:{subjectId}`."""
    bad = [r for r in reasons if not is_reason_code(r)]
    if bad:
        raise ValueError(f"unknown reason codes: {bad}")
    priority = min((_REASON_PRIORITY.get(r, 5) for r in reasons), default=5)
    body = CreateReviewTaskInput(
        kind=kind,  # type: ignore[arg-type]
        subject=TaskSubject(type=subject_type, id=subject_id),  # type: ignore[arg-type]
        reason_codes=list(dict.fromkeys(reasons)),
        evidence=list(evidence),
        priority=priority,
        due_at=iso_z(now + sla(kind, reasons, now, days_to_deadline=days_to_deadline)),
    )
    return body, f"{kind}:{subject_type}:{subject_id}"
