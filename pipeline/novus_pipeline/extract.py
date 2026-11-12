"""LLM extraction of one Snapshot through novus_llm, then deterministic validation (plan 4.7).

The model only pre-fills a Curator's diff: it sees the canonical text (never the watch text or
the hidden channel), cites quotes that the locator must find, and never closes a task. When the
host forbids AI input, or no key is configured, or anything fails, the outcome says so and the
Curator proceeds by hand.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from novus_llm import Gateway, LLMRequest, LLMResult, SourcePolicy, SubjectRef, UntrustedDoc

from .evidence import EvidenceText, FieldKind, locate
from .models import ExtractionDeltaV1, ExtractionIngest, ExtractionPageV1
from .normalize import NormalizedDoc
from .rules import extract_rules
from .validators import CycleContext, ValidationReport, validate_extraction, validation_section

PAGE_ROUTE = "extract.page.v1"
DELTA_ROUTE = "extract.delta.v1"


@dataclass(frozen=True)
class SnapshotContext:
    snapshot_id: str
    url: str
    host_policy: Literal["allowed", "api_only", "manual_only", "link_only", "never"]
    ai_input_allowed: bool
    fetched_at: datetime


@dataclass
class ExtractionOutcome:
    status: Literal["drafted", "manual"]
    reason_code: str | None = None  # draft_unavailable:{code} or refused:{category}
    ingest: ExtractionIngest | None = None
    report: ValidationReport | None = None
    llm: LLMResult | None = None


def _policy_reason(snap: SnapshotContext) -> str | None:
    if snap.host_policy not in ("allowed", "api_only"):
        return "draft_unavailable:policy_blocked"
    if not snap.ai_input_allowed:
        return "draft_unavailable:policy_blocked"
    return None


def extract_page(gateway: Gateway, doc: NormalizedDoc, snap: SnapshotContext, ctx: CycleContext) -> ExtractionOutcome:
    blocked = _policy_reason(snap)
    if blocked:
        return ExtractionOutcome("manual", blocked)  # never reaches the gateway, so no spend
    req = LLMRequest(
        route_id=PAGE_ROUTE,
        subject=SubjectRef(type="snapshot", id=snap.snapshot_id),
        source=SourcePolicy(url=snap.url, host_policy=snap.host_policy, ai_input_allowed=snap.ai_input_allowed),
        documents=(UntrustedDoc(title=snap.url, text=doc.canonical_text),),
        variables={"fetched_on": snap.fetched_at.date().isoformat(), "source_url": snap.url},
        idempotency_key=f"llm:{PAGE_ROUTE}:{snap.snapshot_id}:{doc.main_text_sha256[:16]}",
    )
    result = gateway.run(req, ExtractionPageV1)
    if not result.ok:
        return ExtractionOutcome("manual", result.draft_unavailable_code, llm=result)
    proposal: ExtractionPageV1 = result.parsed
    report = validate_extraction(proposal, EvidenceText.from_doc(doc), ctx, extract_rules(doc, ctx.fetched_at))
    ingest = ExtractionIngest(
        snapshot_id=snap.snapshot_id,
        route_id=result.route_id,
        route_version=str(result.route_version),
        model_requested=result.model_requested,
        model_served=result.model_served,
        prompt_version=result.prompt_version,
        request_id=result.request_id or result.call_id,
        payload=proposal,
        # The proposal never travels alone: blocked fields carry their codes to the Curator.
        validation=validation_section(report),
    )
    return ExtractionOutcome("drafted", None, ingest, report, result)


@dataclass
class DeltaOutcome:
    status: Literal["drafted", "manual"]
    reason_code: str | None = None
    changes: ExtractionDeltaV1 | None = None
    quote_codes: dict[str, str | None] | None = None
    llm: LLMResult | None = None


def extract_delta(
    gateway: Gateway,
    doc: NormalizedDoc,
    windows: Sequence[str],
    verified: Mapping[str, str],
    snap: SnapshotContext,
) -> DeltaOutcome:
    """Ask whether verified values still hold in the changed windows. A model "unchanged" never
    closes a task; it only annotates the diff a Curator already has."""
    blocked = _policy_reason(snap)
    if blocked:
        return DeltaOutcome("manual", blocked)
    fields = "\n".join(f"- {k}: {v}" for k, v in sorted(verified.items()))
    req = LLMRequest(
        route_id=DELTA_ROUTE,
        subject=SubjectRef(type="snapshot", id=snap.snapshot_id),
        source=SourcePolicy(url=snap.url, host_policy=snap.host_policy, ai_input_allowed=snap.ai_input_allowed),
        documents=(
            UntrustedDoc(title=snap.url + " (changed windows)", text="\n\n".join(windows)),
            # Verified values are Novus's own Curator-approved facts, framed like the page text.
            UntrustedDoc(title="verified fields", text=fields),
        ),
        variables={"fetched_on": snap.fetched_at.date().isoformat(), "source_url": snap.url},
        idempotency_key=f"llm:{DELTA_ROUTE}:{snap.snapshot_id}:{doc.key_windows_sha256[:16]}",
    )
    result = gateway.run(req, ExtractionDeltaV1)
    if not result.ok:
        return DeltaOutcome("manual", result.draft_unavailable_code, llm=result)
    delta: ExtractionDeltaV1 = result.parsed
    text = EvidenceText.from_doc(doc)
    codes: dict[str, str | None] = {}
    for change in delta.changes:
        if change.verdict in ("changed", "removed") and change.quote:
            loc = locate(text, change.quote, FieldKind.TEXT)
            codes[change.field_id] = loc.code
        else:
            codes[change.field_id] = None
    return DeltaOutcome("drafted", None, delta, codes, result)
