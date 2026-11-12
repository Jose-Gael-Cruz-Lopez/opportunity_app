"""Pydantic mirrors of the shared zod contracts the pipeline sends or receives.

Source of truth: shared/contracts/*.ts, exported as JSON Schema to shared/contracts/json-schema/.
tests/test_pipeline_contract_drift.py compares every mirror here with those files (property
names, required sets and enum values), so drift fails CI. The Worker re-validates every body with
zod; refinements that JSON Schema cannot express live only there.

Wire names are camelCase (as in the contracts); Python attributes are snake_case. Serialize with
`to_wire(model)`.

Nothing here can carry student data: no model has a field for a profile, a tracker item or a
SensitiveAnswers key, and the pipeline imports no such type.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# --- enums mirrored from shared/taxonomy and shared/contracts ---------------------------------

SourceKind = Literal[
    "official_page", "official_pdf", "federal_api", "ats_board", "list_row", "campus_page", "hint", "licensed"
]
HostPolicyName = Literal["allowed", "api_only", "manual_only", "link_only", "never"]
DeadlineKind = Literal[
    "application", "campus_internal", "nomination", "priority_round", "recommendation", "supplemental",
    "interest_form", "decision_expected", "program_start",
]  # fmt: skip
RequirementKind = Literal[
    "recommendation", "essay", "campus_nomination", "test_score", "portfolio", "resume", "transcript",
    "interview", "fee", "coursework", "gpa_floor", "other",
]  # fmt: skip
EligibilityDimension = Literal[
    "standing", "enrollment", "transfer", "gpa", "citizenship", "pell", "institution", "field",
    "identity", "age", "residency", "first_gen", "prior_award", "team", "host_enrollment",
]  # fmt: skip
EvidenceEntity = Literal[
    "program", "program_cycle", "deadline", "requirement", "eligibility_rule_set", "program_cycle_count",
    "institution_participation", "organization", "official_domain",
]  # fmt: skip
ReviewTaskKind = Literal[
    "new_program", "cycle_update", "reconfirm", "rollover", "posting_match", "possible_duplicate",
    "error_report", "community_hint", "source_broken", "extraction_failed", "scam_flag", "overdue_opening",
    "counts_table", "outcome_anomaly", "relation_proposal", "band_model_approval", "campus_deadline",
    "sponsor_claim", "owner_update", "promotion_copy", "resource_link",
]  # fmt: skip
PipelineJobKind = Literal[
    "curate_import", "fetch", "nsf_sync", "list_sync", "rollover", "predict_cycles", "llm", "llm_collect",
    "eval_run", "docintel_ocr_hint", "docintel_eval", "mirror_export", "backup_copy",
]  # fmt: skip
REVIEW_REASON_CODES: frozenset[str] = frozenset(
    {"key_change", "quote_missing", "urgent_recheck", "pdf_changed", "close_unconfirmed", "value_changed",
     "key_change_pending_draft", "deadline_audit", "page_changed", "extraction_change", "evidence_changed",
     "ocr_disagreement", "hidden_text_suspect", "no_text_layer", "parse_failed", "list_row",
     "pre_fetcher_entry", "slug_collision", "max_tokens", "schema_invalid", "budget_deferred", "killed",
     "policy_blocked", "error", "outcome_over_count", "outcome_flagged", "outcome_decision_week"}
)  # fmt: skip
ContractChangeClass = Literal["none", "cosmetic", "minor", "key"]
LeafStatus = Literal["found", "not_stated", "ambiguous"]
LeafBasis = Literal["stated", "inferred"]
PageKind = Literal["current_cycle", "next_cycle_announced", "past_cycle", "program_ended", "not_a_program_page", "mixed"]

Sha256 = Field(pattern=r"^[0-9a-f]{64}$")


class Wire(BaseModel):
    """camelCase on the wire, snake_case in Python, unknown keys rejected (zod `.strict()`)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def to_wire(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True)


def iso_z(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


# --- extraction.v1 (snake_case on the wire, as the model writes it) -----------------------------


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Leaf(Strict):
    value: str
    quote: str
    status: LeafStatus
    basis: LeafBasis


class DeadlineDraft(Strict):
    kind: DeadlineKind
    scope: Literal["national", "campus"]
    precision: Literal["exact", "date_only", "month_only", "rolling", "tbd"]
    tz_mode: Literal["fixed", "applicant_local", "not_stated"]
    round_label: str
    local_date: str
    local_time: str
    time_zone_text: str
    quote: str
    status: LeafStatus
    basis: LeafBasis


class RequirementDraft(Strict):
    kind: RequirementKind
    detail: str
    quote: str


class EligibilityRow(Strict):
    clause_id: str
    row_kind: Literal["clause", "attest"]
    dimension: EligibilityDimension
    operator: Literal["in", "not_in", "gte", "lte", "between", "is_true", "is_false", "no_restriction"]
    values: list[str]
    measure: str
    as_of: str
    borderline: list[str]
    group: str
    quote: str


LEAF_FIELDS: tuple[str, ...] = (
    "program_name", "organization_name", "cycle_label", "cycle_status", "opens_on", "application_url",
    "cost_to_participate", "stipend", "award_count", "applicant_count", "nomination_required",
    "campus_quota_text", "primary_type",
)  # fmt: skip


class ExtractionPageV1(Strict):
    page_kind: PageKind
    program_name: Leaf
    organization_name: Leaf
    cycle_label: Leaf
    cycle_status: Leaf
    opens_on: Leaf
    application_url: Leaf
    cost_to_participate: Leaf
    stipend: Leaf
    award_count: Leaf
    applicant_count: Leaf
    nomination_required: Leaf
    campus_quota_text: Leaf
    primary_type: Leaf
    deadlines: list[DeadlineDraft]
    requirements: list[RequirementDraft]
    eligibility_rows: list[EligibilityRow]


class DeltaChange(Strict):
    """extract.delta.v1 item (plan 4.7). Not yet in shared/contracts; pipeline-owned for now."""

    field_id: str
    verdict: Literal["unchanged", "changed", "removed", "not_found"]
    value: str
    quote: str
    status: LeafStatus
    basis: LeafBasis


class ExtractionDeltaV1(Strict):
    changes: list[DeltaChange]


# --- internal ingest bodies ---------------------------------------------------------------------


class SnapshotIngest(Wire):
    source_id: str | None
    source_kind: SourceKind
    requested_url: str
    final_url: str
    redirect_chain: list[str] = Field(max_length=10)
    fetched_at: str
    http_status: int = Field(ge=100, le=599)
    content_type: str = Field(max_length=200)
    raw_sha256: str = Sha256
    main_text_sha256: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    normalizer_version: str = Field(max_length=40)
    raw_base64: str | None = Field(max_length=14_000_000)
    main_text: str | None = Field(max_length=2_000_000)
    ai_input_allowed: bool
    pdf_pages: int | None = Field(ge=0)


class SnapshotIngestResult(Wire):
    snapshot_id: str
    change_class: ContractChangeClass | None
    stored: bool


class ValidationFinding(Wire):
    code: str = Field(max_length=60)
    path: str = Field(max_length=200)
    severity: Literal["block", "review"]


class FieldValidation(Wire):
    """The deterministic evidence check of one proposed field (validators.FieldCheck).

    `outcome == "blocked"` (or any `block` finding at this path) means the value must not be
    prefilled or shown as a value: the Curator sees the field unhighlighted, with its code."""

    path: str = Field(max_length=200)
    outcome: Literal["exact", "aligned", "blocked", "not_stated"]
    blocked: bool
    code: str | None = Field(default=None, max_length=60)
    flags: list[str] = Field(default_factory=list, max_length=20)
    channel: Literal["canonical", "watch"] = "canonical"
    # Offsets into the Snapshot's canonical text where the quote was located.
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)
    parsed_value: str | None = Field(default=None, max_length=200)
    confidence: Literal["high", "medium", "low"]


class ExtractionValidation(Wire):
    """The ValidationReport of one proposal, codes and offsets only (no page text)."""

    validator_version: str = Field(max_length=40)
    blocked: bool
    codes: list[str] = Field(max_length=100)
    blocked_paths: list[str] = Field(max_length=200)
    fields: list[FieldValidation] = Field(max_length=400)
    findings: list[ValidationFinding] = Field(max_length=400)


class ExtractionIngest(Wire):
    snapshot_id: str
    route_id: str = Field(max_length=60)
    route_version: str = Field(max_length=20)
    model_requested: str = Field(max_length=80)
    model_served: str = Field(max_length=80)
    prompt_version: str = Field(max_length=40)
    schema_version: Literal["extraction.v1"] = "extraction.v1"
    request_id: str = Field(max_length=120)
    payload: ExtractionPageV1
    # Pending in shared/contracts/internal.ts ExtractionIngestSchema (see the drift test's
    # PENDING_CONTRACT_FIELDS): the proposal never travels without its validation.
    validation: ExtractionValidation


class Heartbeat(Wire):
    worker: str = Field(max_length=60)
    at: str
    version: str = Field(max_length=40)
    leased_jobs: int = Field(ge=0)


class Job(Wire):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    id: str
    kind: str
    payload: dict[str, Any]
    idempotency_key: str
    concurrency_key: str | None
    status: Literal["pending", "leased", "done", "dead"]
    priority: int
    attempts: int
    max_attempts: int
    run_after: str
    lease_owner: str | None
    lease_expires_at: str | None
    last_error: str | None
    finished_at: str | None


class JobLeaseRequest(Wire):
    kinds: list[PipelineJobKind] = Field(min_length=1)
    max: int = Field(default=5, ge=1, le=50)
    lease_seconds: int = Field(default=600, ge=30, le=3600)
    owner: str = Field(min_length=1, max_length=100)


class JobLeaseResponse(Wire):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    jobs: list[Job]


class JobComplete(Wire):
    owner: str
    result: dict[str, Any] = Field(default_factory=dict)


class JobFail(Wire):
    owner: str
    error_class: str = Field(min_length=1, max_length=200)
    disposition: Literal["retry", "defer", "dead"]


class TaskSubject(Wire):
    type: EvidenceEntity
    id: str


class CreateReviewTaskInput(Wire):
    kind: ReviewTaskKind
    subject: TaskSubject
    reason_codes: list[str] = Field(min_length=1, max_length=20)
    evidence: list[str] = Field(default_factory=list, max_length=50)
    priority: int = Field(default=5, ge=0, le=9)
    due_at: str | None = None


# --- pipeline job payloads (ids and public program facts only) ------------------------------------


class VerifiedQuoteIn(Wire):
    family: Literal["deadline", "status", "launch_filter", "other"]
    quote: str
    deadline_date: str | None = None


class FetchBaseline(Wire):
    snapshot_id: str
    raw_sha256: str
    main_text_sha256: str | None = None
    watch_tokens_sha256: str | None = None
    normalizer_version: str | None = None


class FetchJobPayload(Wire):
    """`fetch` job payload. Public program-side facts only; the Worker builds it from the Source."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    source_id: str
    url: str
    kind: SourceKind = "official_page"
    program_cycle_id: str | None = None
    approval: Literal["approved", "pending_approval", "rejected"] = "approved"
    etag: str | None = None
    last_modified: str | None = None
    baseline: FetchBaseline | None = None
    verified_quotes: list[VerifiedQuoteIn] = Field(default_factory=list)
    volatile_patterns: list[str] = Field(default_factory=list)
    shadow: bool = False  # plan 4.6 shadow start: record KEY results, open no key_change tasks
    # Inputs to next_check_at(): registry facts and s07's monitoring windows only.
    host_policy: HostPolicyName = "allowed"
    cycle_status: str | None = None
    last_deadline_at: str | None = None
    days_to_deadline: int | None = None
    daily_windows: list[tuple[str, str]] = Field(default_factory=list)
    every3_windows: list[tuple[str, str]] = Field(default_factory=list)


class SnapshotMeta(Wire):
    """`GET /internal/v1/snapshots/:id` (plan 4.12 baseline reads; not yet in the route map)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    id: str
    final_url: str
    raw_sha256: str
    content_type: str = ""
    fetched_at: str
    host_policy: HostPolicyName
    ai_input_allowed: bool
    cycle_key: str | None = None
    official_domains: list[str] = Field(default_factory=list)
    volatile_patterns: list[str] = Field(default_factory=list)


class LlmJobPayload(Wire):
    """`llm` job payload: ids only (plan 8.9)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    route_id: Literal["extract.page.v1", "extract.delta.v1"]
    snapshot_id: str
    program_cycle_id: str | None = None
    priority: int = 5
