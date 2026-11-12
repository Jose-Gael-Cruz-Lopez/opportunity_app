"""Job handlers and the drain loop: lease from the Worker, run, complete or fail (plan 4.2).

Payloads carry ids and public program-side facts only. Results carry outcomes, hashes, codes and
the key-window diff of the public page, never student data. Exceptions are reported by class
name only, because Modal keeps function I/O and logs.

A fetch result carries what the Worker needs for the next fetch of the Source (`baseline`,
`validators`), so change detection and conditional GETs work once the Worker copies them into
the next payload (see `next_fetch_facts`).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from .config import INLINE_SNAPSHOT_BYTES
from .detect import Change, ChangeClass, SnapshotFacts, VerifiedQuote, classify_change, triage
from .extract import SnapshotContext, extract_page
from .fetcher import FetchRequest, Fetcher, SourceCheck
from .internal_client import InternalApi, InternalApiError, encode_inline
from .models import FetchJobPayload, Heartbeat, Job, LlmJobPayload, SnapshotIngest, iso_z, to_wire
from .normalize import NormalizedDoc, NormalizeError, normalize_html
from .review import build_task
from .schedule import CycleFacts, MonitoringWindows, SourceFacts, next_check_at
from .validators import CycleContext

log = logging.getLogger("novus_pipeline.jobs")
VERSION = "0.1.0"
MAX_DIFF_WINDOWS = 20
MAX_WINDOW_CHARS = 600

Normalizer = Callable[[bytes, str | None, Sequence[str]], NormalizedDoc]


def local_normalizer(raw: bytes, content_type: str | None, volatile: Sequence[str]) -> NormalizedDoc:
    return normalize_html(raw, content_type, volatile_patterns=volatile)


class JobError(Exception):
    """A handled failure with a disposition for `/jobs/:id/fail`."""

    def __init__(self, error_class: str, disposition: str = "retry") -> None:
        super().__init__(error_class)
        self.error_class = error_class
        self.disposition = disposition


@dataclass
class PipelineDeps:
    api: InternalApi
    fetcher: Fetcher
    normalizer: Normalizer = local_normalizer
    gateway: Any = None  # novus_llm.Gateway | None
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    # Signed with the `clock` key family, the only pipeline key allowed to call tickCatchUp.
    # None skips the watchdog call (the fetch and llm keys would get a 403 ops alert).
    clock_api: InternalApi | None = None
    monotonic: Callable[[], float] = time.monotonic


def _parse_instant(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _windows(pairs: Sequence[tuple[str, str]]) -> list[tuple[datetime, datetime]]:
    out = []
    for a, b in pairs:
        start, end = _parse_instant(a), _parse_instant(b)
        if start and end:
            out.append((start, end))
    return out


def _next_check(payload: FetchJobPayload, now: datetime) -> str | None:
    src = SourceFacts(payload.kind, payload.host_policy, payload.approval)
    cyc = CycleFacts(payload.cycle_status, _parse_instant(payload.last_deadline_at)) if payload.cycle_status else None
    win = MonitoringWindows(_windows(payload.daily_windows), _windows(payload.every3_windows))
    nxt = next_check_at(src, cyc, win, now)
    return iso_z(nxt) if nxt else None


def _is_html(check: SourceCheck) -> bool:
    ct = check.content_type.lower()
    return not check.is_pdf and ("html" in ct or "xml" in ct or ct == "")


def _diff_summary(change: Change) -> dict[str, list[str]]:
    def clip(ws: Sequence[str]) -> list[str]:
        return [w[:MAX_WINDOW_CHARS] for w in ws[:MAX_DIFF_WINDOWS]]

    return {"removed": clip(change.diff.removed), "added": clip(change.diff.added)}


def _deferred_error(check: SourceCheck) -> str:
    """`deferred:{reason}`, plus when the host may be tried again, for the Worker's scheduler."""
    base = f"deferred:{check.reason}"
    if check.retry_after is not None and check.retry_after > 0:
        return f"{base}:retry_after={int(check.retry_after + 0.999)}s"
    return base


def next_fetch_facts(result: Mapping[str, Any]) -> dict[str, Any]:
    """The FetchJobPayload fields the Worker should store on the Source from a fetch result and
    send with its next fetch job: the new baseline and the HTTP validators (camelCase, as the
    payload expects). Empty when the result changes nothing."""
    out: dict[str, Any] = {}
    if result.get("baseline"):
        out["baseline"] = dict(result["baseline"])
    validators = result.get("validators") or {}
    if validators.get("etag") or validators.get("lastModified"):
        out["etag"] = validators.get("etag")
        out["lastModified"] = validators.get("lastModified")
    return out


def _snapshot_ingest(payload: FetchJobPayload, check: SourceCheck, doc: NormalizedDoc | None, api: InternalApi) -> SnapshotIngest:
    assert check.body is not None and check.raw_sha256 is not None
    inline = len(check.body) <= INLINE_SNAPSHOT_BYTES
    if not inline:
        api.put_raw(check.raw_sha256, check.body, [*check.redirect_chain, check.final_url], check.content_type)
    return SnapshotIngest(
        source_id=payload.source_id,
        source_kind=payload.kind,
        requested_url=check.requested_url,
        final_url=check.final_url,
        redirect_chain=check.redirect_chain[:10],
        fetched_at=iso_z(check.fetched_at),
        http_status=check.http_status or 200,
        content_type=check.content_type[:200],
        raw_sha256=check.raw_sha256,
        main_text_sha256=doc.main_text_sha256 if doc else None,
        normalizer_version=doc.normalizer_version if doc else "raw-only",
        raw_base64=encode_inline(check.body) if inline else None,
        main_text=doc.canonical_text[:2_000_000] if doc else None,
        ai_input_allowed=check.ai_input_allowed,
        pdf_pages=None,
    )


def handle_fetch(job: Job, deps: PipelineDeps) -> dict[str, Any]:
    payload = FetchJobPayload.model_validate(job.payload)
    now = deps.now()
    if payload.approval != "approved":
        return {"outcome": "skipped", "reason": "not_approved"}
    check = deps.fetcher.fetch(
        FetchRequest(payload.url, payload.kind, payload.source_id, payload.etag, payload.last_modified)
    )
    result: dict[str, Any] = {"outcome": check.outcome, "check": check.summary(), "nextCheckAt": _next_check(payload, now)}
    if check.outcome == "deferred":
        raise JobError(_deferred_error(check), "defer")
    if check.outcome == "not_modified":
        result["attestation"] = "not_modified"
        return result
    if check.outcome != "ok":
        return result  # blocked, skipped or failed: the Worker applies source health rules
    result["validators"] = {"etag": check.etag, "lastModified": check.last_modified}

    doc: NormalizedDoc | None = None
    if _is_html(check):
        try:
            doc = deps.normalizer(check.body or b"", check.content_type, payload.volatile_patterns)
        except NormalizeError:
            result["normalize"] = "failed"
    ingest = deps.api.ingest_snapshot(_snapshot_ingest(payload, check, doc, deps.api))
    result["snapshotId"] = ingest.snapshot_id
    # This Snapshot is the baseline for the next fetch of the Source.
    result["baseline"] = {
        "snapshotId": ingest.snapshot_id,
        "rawSha256": check.raw_sha256,
        "mainTextSha256": doc.main_text_sha256 if doc else None,
        "watchTokensSha256": doc.watch_tokens_sha256 if doc else None,
        "normalizerVersion": doc.normalizer_version if doc else "raw-only",
    }

    base_facts: SnapshotFacts | None = None
    base_doc: NormalizedDoc | None = None
    if payload.baseline is not None:
        b = payload.baseline
        if doc is not None and b.raw_sha256 != check.raw_sha256:
            # Re-normalize the baseline's raw bytes so both sides share one normalizer version.
            try:
                base_doc = deps.normalizer(deps.api.get_raw(b.raw_sha256), check.content_type, payload.volatile_patterns)
            except NormalizeError:
                base_doc = None
        base_facts = SnapshotFacts(
            b.raw_sha256,
            base_doc.main_text_sha256 if base_doc else b.main_text_sha256,
            base_doc.watch_tokens_sha256 if base_doc else b.watch_tokens_sha256,
        )
    cur = SnapshotFacts(
        check.raw_sha256 or "",
        doc.main_text_sha256 if doc else None,
        doc.watch_tokens_sha256 if doc else None,
        http_status=check.http_status or 200,
    )
    verified = [VerifiedQuote(v.family, v.quote, v.deadline_date) for v in payload.verified_quotes]
    change = classify_change(base_facts, cur, base_doc, doc, [v.quote for v in verified])
    decision = triage(change, verified, now.date(), is_pdf=doc is None and check.is_pdf)
    result.update(
        {
            "changeClass": change.cls.value,
            "contractChangeClass": change.contract_class,
            "tokensChanged": change.tokens_changed,
            "missingQuoteCount": len(change.missing_quotes),
            "invalidReason": change.invalid_reason,
            "windowDiff": _diff_summary(change) if change.cls is ChangeClass.KEY else None,
            "hashes": {
                "mainTextSha256": cur.main_text_sha256,
                # Hash of the exact stored text (main_text_sha256 masks volatile parts).
                "canonicalTextSha256": doc.canonical_text_sha256 if doc else None,
                "watchTokensSha256": cur.watch_tokens_sha256,
                "keyWindowsSha256": doc.key_windows_sha256 if doc else None,
                "normalizerVersion": doc.normalizer_version if doc else "raw-only",
            },
            "triage": {
                "taskKind": decision.task_kind,
                "reason": decision.reason,
                "reverify": decision.reverify,
                "urgent": decision.urgent,
                "holdReminders": decision.hold_reminders,
            },
        }
    )
    if change.cls in (ChangeClass.NONE, ChangeClass.COSMETIC, ChangeClass.MINOR):
        result["attestation"] = {ChangeClass.NONE: "raw_equal", ChangeClass.COSMETIC: "main_text_equal", ChangeClass.MINOR: "key_windows_equal"}[change.cls]
    shadowed = payload.shadow and decision.reason == "key_change"
    if decision.task_kind == "cycle_update" and payload.program_cycle_id and not shadowed and decision.reason:
        body, dedupe = build_task(
            "cycle_update", "program_cycle", payload.program_cycle_id, [decision.reason], now,
            days_to_deadline=payload.days_to_deadline,
        )
        deps.api.create_review_task(body, dedupe=dedupe)
        result["taskRequested"] = dedupe
    result["shadowed"] = shadowed
    return result


def handle_llm(job: Job, deps: PipelineDeps) -> dict[str, Any]:
    payload = LlmJobPayload.model_validate(job.payload)
    if payload.route_id != "extract.page.v1":
        raise JobError("route_not_enabled", "dead")
    meta = deps.api.get_snapshot(payload.snapshot_id)
    snap = SnapshotContext(meta.id, meta.final_url, meta.host_policy, meta.ai_input_allowed, _parse_instant(meta.fetched_at) or deps.now())
    reason: str | None = None
    outcome_summary: dict[str, Any] = {}
    if deps.gateway is None:
        reason = "draft_unavailable:no_key"
    else:
        raw = deps.api.get_raw(meta.raw_sha256)
        try:
            doc = deps.normalizer(raw, meta.content_type, meta.volatile_patterns)
        except NormalizeError:
            doc = None
            reason = "draft_unavailable:parse_failed"
        if doc is not None:
            ctx = CycleContext(
                fetched_at=snap.fetched_at.date() if isinstance(snap.fetched_at, datetime) else date.today(),
                snapshot_url=snap.url,
                cycle_key=meta.cycle_key,
                official_domains=meta.official_domains,
            )
            outcome = extract_page(deps.gateway, doc, snap, ctx)
            if outcome.status == "drafted" and outcome.ingest is not None and outcome.report is not None:
                # The ingest carries outcome.ingest.validation, so blocked fields reach the
                # Curator with their codes and offsets, never as plain model values.
                deps.api.ingest_extraction(outcome.ingest)
                outcome_summary = {"validation": outcome.report.summary(), "costUsd": outcome.llm.cost_usd if outcome.llm else 0}
            else:
                reason = outcome.reason_code
    if reason and payload.program_cycle_id:
        body, dedupe = build_task("cycle_update", "program_cycle", payload.program_cycle_id, [reason], deps.now())
        deps.api.create_review_task(body, dedupe=dedupe)
    return {"draft": "unavailable" if reason else "attached", "reason": reason, **outcome_summary}


HANDLERS: Mapping[str, Callable[[Job, PipelineDeps], dict[str, Any]]] = {
    "fetch": handle_fetch,
    "llm": handle_llm,
}


@dataclass
class DrainStats:
    leased: int = 0
    completed: int = 0
    failed: int = 0
    released: int = 0
    errors: list[str] = field(default_factory=list)


# A fetch job's worst case with capped waits: robots.txt and the page (each up to a 20 s read
# timeout and a 10 s connect) plus a few capped sleeps. Jobs do not start with less time left.
JOB_RESERVE_SECONDS = 75.0


def drain(
    deps: PipelineDeps,
    kinds: Sequence[str],
    owner: str,
    *,
    max_jobs: int = 5,
    rounds: int = 1,
    time_budget_seconds: float | None = None,
) -> DrainStats:
    """Lease and run jobs. Never raises for a job failure; reports by error class only.

    With `time_budget_seconds` (below the Modal timeout), no job starts and no lease is taken
    once less than JOB_RESERVE_SECONDS remain; jobs already leased are handed back with a
    `defer`, so nothing waits for its lease to expire."""
    stats = DrainStats()
    started = deps.monotonic()

    def time_left() -> bool:
        return time_budget_seconds is None or deps.monotonic() - started < time_budget_seconds - JOB_RESERVE_SECONDS

    if deps.clock_api is not None:
        try:
            deps.clock_api.tick_catch_up()
        except InternalApiError as exc:
            stats.errors.append(f"catch_up:{exc.status}")
    for _ in range(rounds):
        if not time_left():
            break
        jobs = deps.api.lease_jobs(list(kinds), owner, max_jobs=max_jobs)
        if not jobs:
            break
        stats.leased += len(jobs)
        for job in jobs:
            if not time_left():
                try:
                    deps.api.fail_job(job.id, owner, "drain_time_budget", "defer")
                    stats.released += 1
                except InternalApiError as exc:
                    stats.errors.append(f"release:{exc.status}")
                continue
            handler = HANDLERS.get(job.kind)
            try:
                if handler is None:
                    raise JobError("no_handler", "dead")
                result = handler(job, deps)
                deps.api.complete_job(job.id, owner, result)
                stats.completed += 1
            except JobError as exc:
                deps.api.fail_job(job.id, owner, exc.error_class, exc.disposition)
                stats.failed += 1
            except InternalApiError as exc:
                deps.api.fail_job(job.id, owner, f"internal_api_{exc.status}", "retry" if exc.retryable else "dead")
                stats.failed += 1
            except Exception as exc:  # noqa: BLE001 - one bad job must not stop the drain
                log.warning("job failed", extra={"job_id": job.id, "kind": job.kind, "error_class": type(exc).__name__})
                deps.api.fail_job(job.id, owner, type(exc).__name__, "retry")
                stats.failed += 1
    try:
        deps.api.heartbeat(Heartbeat(worker=owner[:60], at=iso_z(deps.now()), version=VERSION, leased_jobs=stats.leased))
    except InternalApiError as exc:
        stats.errors.append(f"heartbeat:{exc.status}")
    return stats


def job_from_dict(data: Mapping[str, Any]) -> Job:
    return Job.model_validate(data)


__all__ = [
    "HANDLERS", "DrainStats", "JobError", "PipelineDeps", "drain", "handle_fetch", "handle_llm", "next_fetch_facts",
    "to_wire",
]  # fmt: skip
