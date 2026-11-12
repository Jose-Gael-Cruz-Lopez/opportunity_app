"""Golden eligibility cases in Python (the "python" runtime of shared/eligibility/golden).

The release gate runs this file. The runner is pipeline/novus_eligibility; these tests prove it
passes on the committed files, that its checks bite (negative controls on copies of the files),
and that the port keeps JavaScript's semantics where Python's differ.
"""

from __future__ import annotations

import inspect
import json
import shutil
from pathlib import Path

import pytest

from novus_eligibility import (
    CATALOGUE,
    ENGINE_VERSION,
    SensitiveInputRejectedError,
    canonical_json,
    compute_rule_set_hash,
    evaluate_eligibility,
    run_golden,
)
from novus_eligibility.catalogue import DATA_DIR
from novus_eligibility.golden import GOLDEN_DIR, load_golden
from novus_eligibility.logic import SUPPORTED_OPERATORS
from novus_eligibility.values import js_number_text, same_json, strict_eq

ASOF = "2027-01-15"
CONTEXT = {
    "anchors": {"program_start": "2027-09-01", "national_deadline": "2027-01-29"},
    "institution": {"id": "00000000-0000-4000-8000-000000000301", "level": "four_year", "calendar": "semester", "academicYearStartMonth": 8, "participates": True},
}


def _rule_set(rules: list[dict], **extra: object) -> dict:
    coverage = {d: "no_restriction" for d in CATALOGUE.dimensions}
    for r in rules:
        coverage[r["dimension"]] = "encoded"
    base = {
        "id": "00000000-0000-4000-8000-000000000999",
        "programCycleId": "00000000-0000-4000-8000-000000000998",
        "version": 1,
        "format": "jsonlogic-v1",
        "state": "draft",
        "templateKey": None,
        "coverage": coverage,
        "rules": rules,
        "anyOf": [],
        "attestations": [],
        "nomination": None,
        "evidence": {},
        "hash": None,
    }
    base.update(extra)
    return base


def _rule(rule_id: str, dimension: str, logic: object, fields: list[str], sensitive: bool = False, as_of: str = "today") -> dict:
    return {
        "id": rule_id,
        "dimension": dimension,
        "group": "all",
        "logic": logic,
        "fields": fields,
        "sensitive": sensitive,
        "asOf": as_of,
        "borderline": [],
        "officialText": f"Sample rule {rule_id}",
        "evidenceKey": None,
    }


@pytest.fixture()
def golden_copy(tmp_path: Path) -> tuple[Path, Path]:
    golden = tmp_path / "golden"
    data = tmp_path / "data"
    shutil.copytree(GOLDEN_DIR, golden)
    shutil.copytree(DATA_DIR, data)
    return golden, data


# ---- the gate ------------------------------------------------------------------------------


def test_golden_cases_pass_in_python() -> None:
    report = run_golden()
    assert report.failures == []
    assert report.ok
    assert report.cases >= 50
    assert report.expectations_checked >= 40
    assert report.twins_checked > 0
    assert report.expectations_checked + report.twins_checked == report.cases
    assert report.rule_sets >= 5


def test_catalogue_and_snapshot_share_the_engine_version() -> None:
    snapshot = json.loads((DATA_DIR / "node-results.json").read_text(encoding="utf-8"))
    assert snapshot["engineVersion"] == ENGINE_VERSION
    assert snapshot["sample"] is True
    assert set(SUPPORTED_OPERATORS) == set(CATALOGUE.operators)


def test_loader_keeps_only_server_safe_keys() -> None:
    files, _, _ = load_golden()
    allowed = {"id", "runtimes", "ruleSet", "context", "asOf", "profile", "expect"}
    assert all(set(c) <= allowed for c in files["cases"])


# ---- negative controls ---------------------------------------------------------------------


def test_detects_a_wrong_label(golden_copy: tuple[Path, Path]) -> None:
    golden, data = golden_copy
    cases = json.loads((golden / "cases.json").read_text())
    target = next(c for c in cases["cases"] if "python" in c["runtimes"] and c["expect"]["verdict"] == "not_met")
    target["expect"]["verdict"] = "met"
    (golden / "cases.json").write_text(json.dumps(cases))
    report = run_golden(golden, data)
    assert not report.ok
    assert any(f.startswith(f"case {target['id']} [python]: verdict") for f in report.failures)


def test_detects_a_tampered_hash(golden_copy: tuple[Path, Path]) -> None:
    golden, data = golden_copy
    sets = json.loads((golden / "rule-sets.json").read_text())
    key = next(iter(sets["ruleSets"]))
    sets["ruleSets"][key]["expectHash"] = "0" * 64
    (golden / "rule-sets.json").write_text(json.dumps(sets))
    assert any(f.startswith(f"rule set {key}") for f in run_golden(golden, data).failures)


def test_detects_drift_from_the_node_results(golden_copy: tuple[Path, Path]) -> None:
    golden, data = golden_copy
    snapshot = json.loads((data / "node-results.json").read_text())
    cid = next(iter(snapshot["results"]))
    rules = snapshot["results"][cid]["rules"]
    if rules:
        rules[0]["reason"] += " (changed)"
        expected = "rules"
    else:
        snapshot["results"][cid]["asOf"] = "2000-01-01"
        expected = "asOf"
    (data / "node-results.json").write_text(json.dumps(snapshot))
    failures = run_golden(golden, data).failures
    assert f"case {cid} [python]: differs from the Node result in {expected}" in failures


# ---- privacy -------------------------------------------------------------------------------


def test_refuses_sensitive_profile_keys() -> None:
    rs = _rule_set([_rule("enrollment", "enrollment", {"==": [{"var": "enrollmentIntensity"}, "full_time"]}, ["enrollmentIntensity"])])
    for key in ("citizenship", "pell", "firstGeneration", "financialNeed", "identity", "identity.race_ethnicity"):
        with pytest.raises(SensitiveInputRejectedError):
            evaluate_eligibility(rs, {key: "x"}, ASOF, CONTEXT)


def test_has_no_parameter_for_device_answers() -> None:
    assert list(inspect.signature(evaluate_eligibility).parameters) == ["rule_set", "profile", "as_of", "context"]


def test_sensitive_rules_and_attestations_stay_unknown() -> None:
    rs = _rule_set(
        [_rule("citizenship", "citizenship", {"in": [{"var": "citizenship"}, ["us_citizen"]]}, ["citizenship"], sensitive=True)],
        attestations=[{"id": "prior", "dimension": "prior_award", "text": "Sample: no prior award.", "sensitive": False, "evidenceKey": None}],
    )
    result = evaluate_eligibility(rs, {}, ASOF, CONTEXT)
    by_id = {r["ruleId"]: r for r in result["rules"]}
    assert by_id["citizenship"]["verdict"] == "unknown"
    assert by_id["citizenship"]["reasonCode"] == "SENSITIVE_ON_DEVICE"
    assert by_id["prior"]["reasonCode"] == "ATTESTATION_ON_DEVICE"
    assert result["sensitiveEvaluated"] is False
    assert result["verdict"] != "met"


# ---- JavaScript semantics ------------------------------------------------------------------


def test_booleans_are_not_numbers() -> None:
    assert not strict_eq(True, 1)
    assert strict_eq(2, 2.0)
    assert not same_json({"a": True}, {"a": 1})
    rs = _rule_set([_rule("participates", "institution", {"==": [{"var": "institutionParticipates"}, 1]}, ["institutionParticipates"])])
    assert evaluate_eligibility(rs, {}, ASOF, CONTEXT)["rules"][0]["verdict"] == "not_met"


def test_numbers_print_like_javascript() -> None:
    assert js_number_text(4.0) == "4"
    assert js_number_text(3.25) == "3.25"
    assert js_number_text(-0.0) == "0"
    assert canonical_json({"b": 4.0, "a": [True, None, "é"]}) == '{"a":[true,null,"é"],"b":4}'


def test_type_mismatch_is_a_rule_error_not_a_verdict() -> None:
    rs = _rule_set([_rule("enrollment", "enrollment", {"<": [{"var": "enrollmentIntensity"}, 3]}, ["enrollmentIntensity"])])
    rule = evaluate_eligibility(rs, {"enrollmentIntensity": "full_time"}, ASOF, CONTEXT)["rules"][0]
    assert (rule["verdict"], rule["reasonCode"], rule["resolver"]) == ("unknown", "RULE_ERROR", "novus")


def test_missing_answer_never_becomes_yes() -> None:
    rs = _rule_set([_rule("gpa", "gpa", {">=": [{"var": "gpaMin"}, 3.0]}, ["gpaMin"])])
    result = evaluate_eligibility(rs, {}, ASOF, CONTEXT)
    assert result["rules"][0]["reasonCode"] == "MISSING_FIELD"
    assert result["rules"][0]["missingFields"] == ["gpaBand"]
    straddle = evaluate_eligibility(rs, {"gpaBand": "2_75_to_2_99"}, ASOF, CONTEXT)["rules"][0]
    assert straddle["verdict"] == "not_met"
    edge = evaluate_eligibility(_rule_set([_rule("gpa", "gpa", {">=": [{"var": "gpaMin"}, 3.1]}, ["gpaMin"])]), {"gpaBand": "3_0_to_3_24"}, ASOF, CONTEXT)["rules"][0]
    assert (edge["verdict"], edge["reasonCode"]) == ("unknown", "STRADDLES_LIMIT")


def test_string_and_remainder_operators_follow_javascript() -> None:
    def run(logic: object) -> str:
        rs = _rule_set([_rule("x", "residency", logic, ["residenceState"])])
        return evaluate_eligibility(rs, {"residenceState": "CA"}, ASOF, CONTEXT)["rules"][0]["verdict"]

    assert run({"==": [{"substr": [{"var": "residenceState"}, -1]}, "A"]}) == "met"
    assert run({"==": [{"substr": ["abcdef", 0, -8]}, "abcd"]}) == "met"  # slice(0, -2)
    assert run({"==": [{"%": [-7, 3]}, -1]}) == "met"
    assert run({"==": [{"cat": [{"var": "residenceState"}, 2.0]}, "CA2"]}) == "met"


def test_rule_set_hash_matches_the_typescript_hash() -> None:
    sets = json.loads((GOLDEN_DIR / "rule-sets.json").read_text())
    for key, entry in sets["ruleSets"].items():
        assert compute_rule_set_hash(entry["ruleSet"]) == entry["expectHash"], key
