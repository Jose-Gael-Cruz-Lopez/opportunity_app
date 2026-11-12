"""The evaluator, ported from shared/eligibility/evaluate.ts and reasons.ts (server-safe half).

Pure: no clock (as_of is an argument), no I/O. There is no way to pass sensitive answers or
attestation answers: sensitive rules always come back unknown with SENSITIVE_ON_DEVICE and every
attestation with ATTESTATION_ON_DEVICE, exactly like the Worker. Results are plain dicts with the
same keys and values as EligibilityResult in shared/contracts/eligibility.ts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

from .catalogue import CATALOGUE, cip_matches_prefix, major_family_for_cip
from .fields import FieldEnv, FieldReading, is_answered, read_field
from .logic import RuleEvaluationError, evaluate_logic_tri, inspect_json_logic
from .standing import is_iso_date
from .values import NO, UNKNOWN, YES, Known, SetValue, agree3, and3, known, or3, tri_to_verdict

MAX_WORLDS = 4096

_CAUSE_ORDER = (
    ("context", "CONTEXT_MISSING", "novus"),
    ("missing", "MISSING_FIELD", "student"),
    ("sensitive_missing", "SENSITIVE_UNANSWERED", "student"),
    ("conflict", "PROFILE_CONFLICT", "student"),
    ("calendar", "CALENDAR_CONVERSION", "student"),
    ("coarse", "STRADDLES_LIMIT", "student"),
    ("participation", "PARTICIPATION_UNCONFIRMED", "student"),
)

ATTESTATION_GROUP = "attestations"


class SensitiveInputRejectedError(ValueError):
    """Raised when a profile carries a sensitive key: those answers stay on the student's device."""


@dataclass(frozen=True)
class _Outcome:
    verdict: int
    code: str
    missing_fields: tuple[str, ...]
    resolver: str | None


# ---- copy ------------------------------------------------------------------------------------


def render_template(template: str, params: Mapping[str, str]) -> str:
    text = re.sub(r"\{([a-zA-Z]+)\}", lambda m: params.get(m[1], ""), template)
    text = re.sub(r"\s+", " ", text).strip()
    limit = CATALOGUE.max_text
    return text if len(text) <= limit else f"{text[: limit - 3].rstrip()}..."


def render_reason(code: str, params: Mapping[str, str]) -> str:
    return render_template(CATALOGUE.reasons[code], params)


def describe_fields(fields: tuple[str, ...] | list[str]) -> str:
    labels: list[str] = []
    for f in dict.fromkeys(fields):
        d = CATALOGUE.field(f)
        labels.append(d.label.lower() if d else f)
    if len(labels) <= 1:
        return labels[0] if labels else "the missing answer"
    return f"{', '.join(labels[:-1])} and {labels[-1]}"


def sentence(text: str) -> str:
    t = text.strip()
    return t if re.search(r"[.!?]$", t) else f"{t}."


# ---- rules -----------------------------------------------------------------------------------


def _anchor_for(rule: Mapping[str, Any], env: FieldEnv) -> str | None:
    if rule["asOf"] == "today":
        return env.today
    date = (env.context.get("anchors") or {}).get(rule["asOf"])
    return date if date and is_iso_date(date) else None


class _Scope:
    def __init__(self, readings: Mapping[str, FieldReading], overlay: Mapping[str, Any]) -> None:
        self._readings = readings
        self._overlay = overlay

    def lookup(self, name: str) -> Any:
        fixed = self._overlay.get(name)
        if fixed is not None:
            return fixed
        r = self._readings.get(name)
        if r is None:
            raise RuleEvaluationError(f"logic reads undeclared field {name}")
        return r.value

    def answered(self, name: str) -> bool:
        r = self._readings.get(name)
        return is_answered(r) if r is not None else False


def _evaluate_worlds(logic: Any, readings: Mapping[str, FieldReading]) -> int:
    candidates = sorted(
        ((key, [known(v) for v in r.value.values]) for key, r in readings.items() if isinstance(r.value, SetValue)),
        key=lambda c: (len(c[1]), c[0]),
    )
    splits: list[tuple[str, list[Known]]] = []
    worlds = 1
    for key, values in candidates:
        if worlds * len(values) > MAX_WORLDS:
            continue
        worlds *= len(values)
        splits.append((key, values))
    verdicts: list[int] = []

    def assign(i: int, overlay: dict[str, Any]) -> None:
        if i == len(splits):
            verdicts.append(evaluate_logic_tri(logic, _Scope(readings, overlay)))
            return
        key, values = splits[i]
        for v in values:
            overlay[key] = v
            assign(i + 1, overlay)
        overlay.pop(key, None)

    assign(0, {})
    return agree3(verdicts)


def _is_borderline_major(rule: Mapping[str, Any], env: FieldEnv) -> bool:
    if rule["dimension"] != "field":
        return False
    major = env.profile.get("majorCip")
    minor = env.profile.get("minorCip")
    if env.profile.get("majorFamily") == "undeclared":
        return True
    if major and major_family_for_cip(major) is None:
        return True
    return any(cip and any(cip_matches_prefix(cip, prefix) for prefix in rule.get("borderline", [])) for cip in (major, minor))


def _evaluate_rule(rule: Mapping[str, Any], env: FieldEnv) -> _Outcome:
    if rule["sensitive"]:
        sensitive_fields = tuple(f for f in rule["fields"] if CATALOGUE.is_sensitive_field(f))
        return _Outcome(UNKNOWN, "SENSITIVE_ON_DEVICE", sensitive_fields, "student")
    anchor = _anchor_for(rule, env)
    names = list(dict.fromkeys([*rule["fields"], *inspect_json_logic(rule["logic"])[0]]))
    readings: dict[str, FieldReading] = {}
    try:
        for name in names:
            readings[name] = read_field(name, env, anchor)
    except Exception:
        return _Outcome(UNKNOWN, "RULE_ERROR", (), "novus")
    try:
        verdict = _evaluate_worlds(rule["logic"], readings)
    except (RuleEvaluationError, ValueError):
        return _Outcome(UNKNOWN, "RULE_ERROR", (), "novus")
    statuses = {r.status for r in readings.values()}
    missing_fields = tuple(
        dict.fromkeys(b for r in readings.values() if r.status in ("missing", "sensitive_missing") for b in r.blame)
    )
    if verdict == YES and "calendar" in statuses:
        return _Outcome(UNKNOWN, "CALENDAR_CONVERSION", missing_fields, "student")
    if verdict == NO and _is_borderline_major(rule, env):
        return _Outcome(UNKNOWN, "BORDERLINE_FIELD", missing_fields, "student")
    if verdict == YES:
        return _Outcome(verdict, "MET", (), None)
    if verdict == NO:
        return _Outcome(verdict, "NOT_MET", (), None)
    for status, code, resolver in _CAUSE_ORDER:
        if status in statuses:
            return _Outcome(verdict, code, missing_fields, resolver)
    return _Outcome(verdict, "UNDETERMINED", missing_fields, "novus")


def _coverage_of(rule_set: Mapping[str, Any], dim: str) -> str:
    state = (rule_set.get("coverage") or {}).get(dim) or "not_reviewed"
    if state == "none_stated" and dim in CATALOGUE.launch_dimensions:
        return "not_reviewed"
    return state


def _evidence(rule_set: Mapping[str, Any], key: str | None) -> Any:
    if not key:
        return None
    return (rule_set.get("evidence") or {}).get(key)


def _rule_result(rule: Mapping[str, Any], outcome: _Outcome, rule_set: Mapping[str, Any]) -> dict[str, Any]:
    params = {
        "officialText": sentence(rule["officialText"]),
        "fields": describe_fields(outcome.missing_fields),
        "dimension": CATALOGUE.dimension_labels[rule["dimension"]],
    }
    return {
        "ruleId": rule["id"],
        "dimension": rule["dimension"],
        "group": rule["group"],
        "verdict": tri_to_verdict(outcome.verdict),
        "sensitive": rule["sensitive"],
        "reasonCode": outcome.code,
        "reason": render_reason(outcome.code, params),
        "officialText": rule["officialText"],
        "missingFields": list(outcome.missing_fields),
        "resolver": outcome.resolver,
        "evidenceKey": rule.get("evidenceKey"),
        "evidence": _evidence(rule_set, rule.get("evidenceKey")),
    }


def _attestation_result(a: Mapping[str, Any], rule_set: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "ruleId": a["id"],
        "dimension": a["dimension"],
        "group": ATTESTATION_GROUP,
        "verdict": "unknown",
        "sensitive": a["sensitive"],
        "reasonCode": "ATTESTATION_ON_DEVICE",
        "reason": render_reason("ATTESTATION_ON_DEVICE", {"officialText": sentence(a["text"])}),
        "officialText": a["text"],
        "missingFields": [],
        "resolver": "student",
        "evidenceKey": a.get("evidenceKey"),
        "evidence": _evidence(rule_set, a.get("evidenceKey")),
    }


def _pending_for(r: Mapping[str, Any], kind: str) -> dict[str, Any]:
    resolver = r["resolver"] or "student"
    if kind == "attestation":
        template = CATALOGUE.self_check["attestation"]
    elif resolver == "novus":
        template = CATALOGUE.self_check["rule_novus"]
    else:
        template = CATALOGUE.self_check["rule"]
    return {
        "id": r["ruleId"],
        "kind": kind,
        "dimension": r["dimension"],
        "sensitive": r["sensitive"],
        "resolver": resolver,
        "selfCheckText": render_template(template, {"officialText": sentence(r["officialText"])}),
    }


def _status_for(verdict: int, pending: list[dict[str, Any]]) -> str:
    if verdict == YES:
        return "eligible"
    if verdict == NO:
        return "not_eligible"
    return "conditional" if pending and all(p["resolver"] == "student" for p in pending) else "unknown"


def missing_rule_set_result(as_of: str) -> dict[str, Any]:
    return {
        "verdict": "unknown",
        "status": "unknown",
        "rules": [],
        "pending": [
            {
                "id": "rule_set",
                "kind": "rule_set_missing",
                "dimension": None,
                "sensitive": False,
                "resolver": "novus",
                "selfCheckText": CATALOGUE.self_check["rule_set_missing"],
            }
        ],
        "nomination": None,
        "ruleSet": None,
        "basedOnListedRequirements": False,
        "asOf": as_of,
        "sensitiveEvaluated": False,
    }


def _reject_sensitive(profile: Mapping[str, Any]) -> None:
    for key in profile:
        if CATALOGUE.is_sensitive_field(key) or key == "identity" or key.startswith("identity."):
            raise SensitiveInputRejectedError(f'profile key "{key}" is sensitive: it is evaluated on the student\'s device only')


def evaluate_eligibility(rule_set: Mapping[str, Any] | None, profile: Mapping[str, Any], as_of: str, context: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Evaluates a rule set for a non-sensitive profile at `as_of` (YYYY-MM-DD).

    Same contract as evaluateEligibility in shared/eligibility/index.ts. `rule_set` is a parsed
    EligibilityRuleSet (defaults applied, as stored); None gives status unknown with a
    rule_set_missing item. Sensitive profile keys are refused.
    """
    if not isinstance(as_of, str) or not is_iso_date(as_of):
        raise ValueError(f"as_of must be an ISO date (YYYY-MM-DD), got {as_of!r}")
    _reject_sensitive(profile)
    if rule_set is None:
        return missing_rule_set_result(as_of)
    env = FieldEnv(profile=profile, context=context or {"anchors": {}, "institution": None}, today=as_of)

    rule_results = [_rule_result(rule, _evaluate_rule(rule, env), rule_set) for rule in rule_set["rules"]]
    attestation_results = [_attestation_result(a, rule_set) for a in rule_set.get("attestations", [])]

    def tri(r: Mapping[str, Any]) -> int:
        return YES if r["verdict"] == "met" else NO if r["verdict"] == "not_met" else UNKNOWN

    members: list[int] = []
    pending: list[dict[str, Any]] = []
    for r in rule_results:
        if r["group"] == "all":
            members.append(tri(r))
            if r["verdict"] == "unknown":
                pending.append(_pending_for(r, "rule"))

    any_of = rule_set.get("anyOf", [])
    group_ids = list(dict.fromkeys([*(g["id"] for g in any_of), *(r["group"] for r in rule_results if r["group"] != "all")]))
    for gid in group_ids:
        in_group = [r for r in rule_results if r["group"] == gid]
        if not in_group:
            members.append(UNKNOWN)
            label = next((g.get("label") for g in any_of if g["id"] == gid), None)
            label = gid if label is None else label
            pending.append(
                {
                    "id": f"group:{gid}",
                    "kind": "coverage",
                    "dimension": None,
                    "sensitive": False,
                    "resolver": "novus",
                    "selfCheckText": render_template(CATALOGUE.self_check["group"], {"label": label}),
                }
            )
            continue
        group_verdict = or3(tri(r) for r in in_group)
        members.append(group_verdict)
        if group_verdict == UNKNOWN:
            pending.extend(_pending_for(r, "rule") for r in in_group if r["verdict"] == "unknown")

    for r in attestation_results:
        members.append(tri(r))
        pending.append(_pending_for(r, "attestation"))

    rests_on_none_stated = False
    for dim in CATALOGUE.dimensions:
        state = _coverage_of(rule_set, dim)
        if state == "none_stated":
            rests_on_none_stated = True
        has_rules = any(r["dimension"] == dim for r in rule_set["rules"]) or any(a["dimension"] == dim for a in rule_set.get("attestations", []))
        if state == "not_reviewed" or (state == "encoded" and not has_rules):
            members.append(UNKNOWN)
            pending.append(
                {
                    "id": f"coverage:{dim}",
                    "kind": "coverage",
                    "dimension": dim,
                    "sensitive": False,
                    "resolver": "novus",
                    "selfCheckText": render_template(CATALOGUE.self_check["coverage"], {"dimension": CATALOGUE.dimension_labels[dim]}),
                }
            )

    verdict = and3(members)
    return {
        "verdict": tri_to_verdict(verdict),
        "status": _status_for(verdict, pending),
        "rules": [*rule_results, *attestation_results],
        "pending": pending,
        "nomination": rule_set.get("nomination"),
        "ruleSet": {"id": rule_set.get("id"), "version": rule_set["version"], "hash": rule_set.get("hash")},
        "basedOnListedRequirements": verdict == YES and rests_on_none_stated,
        "asOf": as_of,
        "sensitiveEvaluated": False,
    }
