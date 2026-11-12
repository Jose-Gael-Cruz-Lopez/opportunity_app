"""Validator core for one extraction proposal (plan 4.8; S04-033).

`validate_extraction` is a pure function used unchanged by the evaluation runner and production:
proposal + Snapshot text + cycle context in, per-field evidence checks and findings out. Each
finding has 4.8's severity: `block` keeps the field out of the Curator's prefill, `review` sends
it to per-field confirmation. Confidence labels come from validator outcomes, never from a model.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import ValidationError

from .dates import to_date
from .evidence import EvidenceText, FieldCheck, FieldKind, check_deadline, check_leaf, locate
from .models import (
    LEAF_FIELDS,
    DeadlineDraft,
    EligibilityRow,
    ExtractionPageV1,
    ExtractionValidation,
    FieldValidation,
    ValidationFinding,
)
from .policy import normalize_host
from .rules import RuleDeadline
from .taxonomy import OPPORTUNITY_TYPE_SLUGS

Severity = Literal["block", "review"]
VALIDATOR_VERSION = "validators/1"

BLOCK_CODES = frozenset(
    {"SCHEMA_INVALID", "NOT_STATED_WITH_VALUE", "QUOTE_NOT_ON_PAGE", "QUOTE_ALTERED", "HIDDEN_TEXT",
     "UNTRACEABLE", "CLOSE_BEFORE_OPEN", "NO_RESTRICTION_UNSUPPORTED"}
)  # fmt: skip

LEAF_KINDS: Mapping[str, FieldKind] = {
    "program_name": FieldKind.TEXT,
    "organization_name": FieldKind.TEXT,
    "cycle_label": FieldKind.TEXT,
    "cycle_status": FieldKind.STATUS,
    "opens_on": FieldKind.DATE,
    "application_url": FieldKind.URL,
    "cost_to_participate": FieldKind.AMOUNT,
    "stipend": FieldKind.AMOUNT,
    "award_count": FieldKind.COUNT,
    "applicant_count": FieldKind.COUNT,
    "nomination_required": FieldKind.NOMINATION,
    "campus_quota_text": FieldKind.TEXT,
    "primary_type": FieldKind.TEXT,
}
CRITICAL_FAMILIES = frozenset({"deadline", "cycle_status", "eligibility", "application_url"})

_AFFIRMATIVE = re.compile(
    r"\bregardless of\b|\bopen to (?:all|any|everyone)\b|\ball (?:students|applicants|majors|class years|levels)\b"
    r"|\bany (?:major|class year|year of study|citizenship|nationality)\b|\bnot required\b|\bno (?:minimum|citizenship|gpa)\b"
    r"|\bwelcome(?:s)? (?:all|applicants from all)\b|\birrespective of\b",
    re.I,
)
_SENSITIVE_AUDIENCE = re.compile(
    r"\b(?:daca|deferred action|tps|temporary protected status|undocumented|refugees?|asylees?|asylum|f-1|"
    r"pell[- ](?:eligible|recipients?|grant recipients?)|pell only)\b",
    re.I,
)
# A public, minimal instruction detector; the production pattern list lives in the private config.
INSTRUCTION_PATTERN = re.compile(
    r"\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|messages)\b"
    r"|\bdisregard (?:the |all )?(?:previous|prior|above) (?:instructions|text)\b|\bsystem prompt\b"
    r"|<\|?(?:im_start|im_end|system|assistant)\|?>|\byou are (?:now )?(?:an? )?(?:ai|assistant|language model)\b",
    re.I,
)
_MODEL_TEXT_SUSPECT = re.compile(r"https?://|www\.|[\w.+-]+@[\w-]+\.\w+|\+?\d[\d ().-]{8,}\d|<[a-z/!][^>]*>", re.I)
MAX_REQUIREMENT_DETAIL = 200


@dataclass(frozen=True)
class Finding:
    code: str
    path: str
    detail: str = ""

    @property
    def severity(self) -> Severity:
        return "block" if self.code in BLOCK_CODES else "review"


@dataclass(frozen=True)
class CycleContext:
    fetched_at: date
    snapshot_url: str
    cycle_key: str | None = None
    official_domains: Sequence[str] = ()  # Curator-confirmed site and application_portal domains
    verified_rows: Sequence[EligibilityRow] | None = None


@dataclass
class ValidationReport:
    proposal: ExtractionPageV1 | None
    checks: dict[str, FieldCheck] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)
    confidence: dict[str, Literal["high", "medium", "low"]] = field(default_factory=dict)

    @property
    def blocked(self) -> bool:
        return any(f.severity == "block" for f in self.findings)

    def codes(self) -> list[str]:
        return sorted({f.code for f in self.findings})

    def summary(self) -> dict[str, Any]:
        """Codes and labels only: no page text, safe for job results and logs."""
        return {
            "codes": self.codes(),
            "findings": [{"code": f.code, "path": f.path, "severity": f.severity} for f in self.findings],
            "confidence": self.confidence,
        }


def _parsed(check: FieldCheck) -> str | None:
    if check.parsed_value is not None:
        return check.parsed_value[:200]
    d = check.parsed_deadline
    if d is None:
        return None
    return f"{d.local_date}T{d.local_time}" if d.local_time else d.local_date


def validation_section(report: ValidationReport) -> ExtractionValidation:
    """The wire form of a report: what the Curator needs to see which fields are blocked and
    why, and where each quote sits in the canonical text. Codes and offsets only."""
    blocked_paths = sorted(
        {f.path for f in report.findings if f.severity == "block"} | {fid for fid, c in report.checks.items() if c.blocked}
    )
    fields = [
        FieldValidation(
            path=fid,
            outcome=check.outcome,
            blocked=fid in blocked_paths,
            code=check.code,
            flags=list(check.flags)[:20],
            channel=check.channel,
            start=check.start,
            end=check.end,
            parsed_value=None if check.blocked else _parsed(check),
            confidence=report.confidence.get(fid, "low"),
        )
        for fid, check in report.checks.items()
    ]
    return ExtractionValidation(
        validator_version=VALIDATOR_VERSION,
        blocked=report.blocked,
        codes=report.codes(),
        blocked_paths=blocked_paths,
        fields=fields,
        findings=[ValidationFinding(code=f.code, path=f.path, severity=f.severity) for f in report.findings],
    )


def cycle_window(cycle_key: str | None) -> tuple[date, date] | None:
    """Dates a deadline for this cycle may fall on. summer-2027 is 1 Jul 2026 to 30 Jun 2027
    (plan 4.8); the other terms follow the same 'season before, through the term' judgment."""
    if not cycle_key:
        return None
    m = re.fullmatch(r"(spring|summer|fall|winter|year)-(\d{4})|ay-(\d{4})-(\d{2})", cycle_key)
    if not m:
        return None
    if m.group(3):
        y = int(m.group(3))
        return date(y - 1, 1, 1), date(y + 1, 6, 30)
    term, y = m.group(1), int(m.group(2))
    return {
        "summer": (date(y - 1, 7, 1), date(y, 6, 30)),
        "spring": (date(y - 1, 1, 1), date(y, 4, 30)),
        "fall": (date(y - 1, 7, 1), date(y, 10, 31)),
        "winter": (date(y - 1, 4, 1), date(y, 1, 31)),
        "year": (date(y - 1, 1, 1), date(y, 12, 31)),
    }[term]


def _years(text: str) -> set[int]:
    return {int(y) for y in re.findall(r"\b(20\d{2})\b", text)}


def _host_within(url: str, domains: Sequence[str]) -> bool:
    host = normalize_host(urlsplit(url).hostname or "")
    return any(host == normalize_host(d) or host.endswith("." + normalize_host(d)) for d in domains)


def _row_key(row: EligibilityRow) -> tuple[str, str, tuple[str, ...]]:
    return (row.dimension, row.operator, tuple(sorted(v.lower() for v in row.values)))


def _label(check: FieldCheck, rules_agree: bool | None = None) -> Literal["high", "medium", "low"]:
    if check.blocked:
        return "low"
    if check.outcome == "exact" and not check.flags and rules_agree is not False:
        return "high" if rules_agree or rules_agree is None else "medium"
    return "medium"


def parse_proposal(raw: Mapping[str, Any] | ExtractionPageV1) -> tuple[ExtractionPageV1 | None, list[Finding]]:
    if isinstance(raw, ExtractionPageV1):
        return raw, []
    try:
        return ExtractionPageV1.model_validate(raw), []
    except ValidationError as exc:
        paths = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})[:20]
        return None, [Finding("SCHEMA_INVALID", p) for p in paths]


def validate_extraction(
    raw: Mapping[str, Any] | ExtractionPageV1,
    text: EvidenceText,
    ctx: CycleContext,
    rules: Sequence[RuleDeadline] = (),
) -> ValidationReport:
    proposal, schema_findings = parse_proposal(raw)
    report = ValidationReport(proposal, findings=list(schema_findings))
    if proposal is None:
        return report

    def add(check: FieldCheck) -> FieldCheck:
        report.checks[check.field_id] = check
        if check.code:
            report.findings.append(Finding(check.code, check.field_id))
        report.findings.extend(Finding(flag, check.field_id) for flag in check.flags)
        return check

    if ctx.official_domains and not _host_within(ctx.snapshot_url, ctx.official_domains):
        report.findings.append(Finding("UNTRACEABLE", "$", "snapshot host is not an official domain"))
    if INSTRUCTION_PATTERN.search(text.canonical):
        report.findings.append(Finding("INSTRUCTION_PATTERN", "$"))

    for name in LEAF_FIELDS:
        leaf = getattr(proposal, name)
        add(check_leaf(text, name, leaf.value, leaf.quote, leaf.status, LEAF_KINDS[name], ctx.fetched_at))
    pt = proposal.primary_type
    if pt.status == "found" and pt.value not in OPPORTUNITY_TYPE_SLUGS:
        report.findings.append(Finding("TYPE_UNKNOWN", "primary_type"))

    _check_deadlines(proposal.deadlines, text, ctx, rules, add, report)
    _check_requirements(proposal, text, add, report)
    _check_eligibility(proposal.eligibility_rows, text, ctx, add, report)
    _check_cycle(proposal, ctx, report)

    for fid, check in report.checks.items():
        agree = None
        if fid.startswith("deadlines[") and check.parsed_deadline is not None and rules:
            agree = any(r.local_date == check.parsed_deadline.local_date for r in rules)
        label = _label(check, agree)
        if any(f.path == fid and f.severity == "block" for f in report.findings):
            label = "low"
        report.confidence[fid] = label
    return report


def _check_deadlines(
    deadlines: Sequence[DeadlineDraft],
    text: EvidenceText,
    ctx: CycleContext,
    rules: Sequence[RuleDeadline],
    add: Any,
    report: ValidationReport,
) -> None:
    window = cycle_window(ctx.cycle_key)
    by_slot: dict[tuple[str, str, str], set[str]] = {}
    current = report.proposal is not None and report.proposal.page_kind in ("current_cycle", "next_cycle_announced")
    for i, d in enumerate(deadlines):
        fid = f"deadlines[{i}]"
        check = add(
            check_deadline(
                text, fid, quote=d.quote, status=d.status, local_date=d.local_date, local_time=d.local_time,
                tz_mode=d.tz_mode, fetched_at=ctx.fetched_at,
            )
        )
        parsed = check.parsed_deadline
        if parsed is None:
            continue
        by_slot.setdefault((d.kind, d.scope, d.round_label.strip().lower()), set()).add(parsed.local_date)
        day = to_date(parsed.local_date)
        if day is None:
            continue
        if current and d.kind == "application" and day < ctx.fetched_at:
            report.findings.append(Finding("DEADLINE_IN_PAST", fid))
        if window and not (window[0] <= day <= window[1]):
            report.findings.append(Finding("OUT_OF_CYCLE_WINDOW", fid))
        for r in rules:
            if r.kind == d.kind and r.basis == "sentence" and r.local_date != parsed.local_date and r.local_date[:4] == parsed.local_date[:4]:
                if abs((to_date(r.local_date) or day) - day).days <= 7 and d.quote not in r.quote:
                    report.findings.append(Finding("CONFLICTING_DEADLINES", fid, "another deadline sentence names a nearby date"))
                    break
    for (kind, _scope, _round), dates in by_slot.items():
        if len(dates) > 1:
            report.findings.append(Finding("CONFLICTING_DEADLINES", f"deadlines:{kind}", "two dates for one deadline"))


def _check_requirements(proposal: ExtractionPageV1, text: EvidenceText, add: Any, report: ValidationReport) -> None:
    for i, req in enumerate(proposal.requirements):
        fid = f"requirements[{i}]"
        loc = locate(text, req.quote, FieldKind.REQUIREMENT)
        check = FieldCheck(fid, "blocked" if loc.blocked else loc.method or "blocked", code=loc.code, flags=list(loc.flags), start=loc.start, end=loc.end)
        add(check)
        if len(req.detail) > MAX_REQUIREMENT_DETAIL:
            report.findings.append(Finding("REQUIREMENT_DETAIL_LONG", fid))
        if _MODEL_TEXT_SUSPECT.search(req.detail) or INSTRUCTION_PATTERN.search(req.detail):
            report.findings.append(Finding("MODEL_TEXT_SUSPECT", fid))
    for i, d in enumerate(proposal.deadlines):
        if _MODEL_TEXT_SUSPECT.search(d.round_label) or INSTRUCTION_PATTERN.search(d.round_label):
            report.findings.append(Finding("MODEL_TEXT_SUSPECT", f"deadlines[{i}].round_label"))


def _check_eligibility(
    rows: Sequence[EligibilityRow], text: EvidenceText, ctx: CycleContext, add: Any, report: ValidationReport
) -> None:
    for i, row in enumerate(rows):
        fid = f"eligibility_rows[{i}]"
        add(check_leaf(text, fid, "x", row.quote, "found", FieldKind.ELIGIBILITY, ctx.fetched_at))
        if row.operator == "no_restriction" and not _AFFIRMATIVE.search(row.quote):
            report.findings.append(Finding("NO_RESTRICTION_UNSUPPORTED", fid))
        if row.dimension in ("citizenship", "pell") and row.operator in ("in", "is_true") and (
            _SENSITIVE_AUDIENCE.search(row.quote) or any(_SENSITIVE_AUDIENCE.search(v.replace("_", " ")) for v in row.values)
        ):
            report.findings.append(Finding("SENSITIVE_AUDIENCE_SUGGESTED", fid))
    if ctx.verified_rows is not None:
        if {_row_key(r) for r in rows} != {_row_key(r) for r in ctx.verified_rows}:
            report.findings.append(Finding("ELIGIBILITY_CHANGED", "eligibility_rows"))


def _check_cycle(proposal: ExtractionPageV1, ctx: CycleContext, report: ValidationReport) -> None:
    opens = report.checks.get("opens_on")
    app_dates = [
        c.parsed_deadline.local_date
        for fid, c in report.checks.items()
        if fid.startswith("deadlines[") and c.parsed_deadline is not None
        and proposal.deadlines[int(fid[10:-1])].kind == "application"
    ]
    if opens and opens.parsed_value and app_dates:
        o = to_date(opens.parsed_value)
        close = min((d for d in (to_date(x) for x in app_dates) if d), default=None)
        if o and close and close < o:
            report.findings.append(Finding("CLOSE_BEFORE_OPEN", "opens_on"))
    if proposal.page_kind == "past_cycle":
        report.findings.append(Finding("STALE_CYCLE_TEXT", "page_kind"))
    elif ctx.cycle_key and proposal.cycle_label.status == "found":
        want = max(_years(ctx.cycle_key), default=None)
        got = _years(proposal.cycle_label.value)
        if want and got and max(got) < want:
            report.findings.append(Finding("STALE_CYCLE_TEXT", "cycle_label"))
    if proposal.page_kind == "mixed" or len(_years(proposal.cycle_label.value)) > 2:
        report.findings.append(Finding("MULTIPLE_CYCLES_NAMED", "cycle_label"))
