"""Python runner for the eligibility golden cases (shared/eligibility/golden).

The same JSON the Node, workerd and browser runners read. Python is a server-side runtime, so it
reads only the server-safe half of each case: id, runtimes, rule set, context, asOf, profile and
the hand-labelled expectation. Synthetic device answers are never loaded; cases that carry them
list only the browser and node runtimes, and Python checks their redacted twin instead.

Checks, all of which must hold for the release gate:
1. every rule set's canonical hash equals its expectHash;
2. cases that list "python" match their labelled tuple (verdict, status, per-rule verdicts,
   reason codes, missing fields, pending items as a set, basedOnListedRequirements);
3. other cases (redacted twins) never contradict the labelled verdict, keep sensitive rules and
   attestations unknown, and agree on every other rule;
4. every result is deep-equal, with JSON types kept apart, to the Node result in
   data/node-results.json (reason text and evidence included);
5. forgetting one profile answer never flips met <-> not_met, and rule order does not matter.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .catalogue import DATA_DIR, ENGINE_VERSION
from .evaluate import evaluate_eligibility
from .hashing import compute_rule_set_hash
from .values import same_json

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_DIR = REPO_ROOT / "shared" / "eligibility" / "golden"
RUNTIME = "python"
_CASE_KEYS = ("id", "runtimes", "ruleSet", "context", "asOf", "profile", "expect")


@dataclass
class GoldenReport:
    engine_version: str
    cases: int = 0
    expectations_checked: int = 0
    twins_checked: int = 0
    rule_sets: int = 0
    failures: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures and self.expectations_checked > 0


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _server_safe_case(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Copies only the keys a server runtime may read."""
    return {k: copy.deepcopy(raw[k]) for k in _CASE_KEYS if k in raw}


def load_golden(golden_dir: Path = GOLDEN_DIR, data_dir: Path = DATA_DIR) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    cases_file = _read(golden_dir / "cases.json")
    rule_sets_file = _read(golden_dir / "rule-sets.json")
    snapshot = _read(data_dir / "node-results.json")
    files = {
        "engineMin": cases_file["engineMin"],
        "contexts": cases_file["contexts"],
        "cases": [_server_safe_case(c) for c in cases_file["cases"]],
    }
    return files, rule_sets_file, snapshot


def _semver_at_least(have: str, need: str) -> bool:
    a = [int(x) for x in have.split(".")]
    b = [int(x) for x in need.split(".")]
    for i in range(3):
        x = a[i] if i < len(a) else 0
        y = b[i] if i < len(b) else 0
        if x != y:
            return x > y
    return True


def _verdicts(result: Mapping[str, Any]) -> dict[str, str]:
    return {r["ruleId"]: r["verdict"] for r in result["rules"]}


def _flips(a: str | None, b: str | None) -> bool:
    return (a == "met" and b == "not_met") or (a == "not_met" and b == "met")


def _check_expectation(case: Mapping[str, Any], r: Mapping[str, Any], fail: Any) -> None:
    e = case["expect"]
    if r["verdict"] != e["verdict"]:
        fail(f"verdict {r['verdict']}, expected {e['verdict']}")
    if r["status"] != e["status"]:
        fail(f"status {r['status']}, expected {e['status']}")
    if _verdicts(r) != e["rules"]:
        fail(f"rule verdicts {_verdicts(r)}, expected {e['rules']}")
    codes = {x["ruleId"]: x["reasonCode"] for x in r["rules"]}
    if codes != e["reasonCodes"]:
        fail(f"reason codes {codes}, expected {e['reasonCodes']}")
    for rule in r["rules"]:
        want = (e.get("missingFields") or {}).get(rule["ruleId"], [])
        if rule["missingFields"] != want:
            fail(f"{rule['ruleId']} missing fields {rule['missingFields']}, expected {want}")

    def key(p: Mapping[str, Any]) -> str:
        return f"{p['id']}|{p['kind']}|{p['resolver']}|{str(p['sensitive']).lower()}"

    got = sorted(key(p) for p in r["pending"])
    want_pending = sorted(key(p) for p in e["pending"])
    if got != want_pending:
        fail(f"pending {got}, expected {want_pending}")
    if r["basedOnListedRequirements"] is not e["basedOnListedRequirements"]:
        fail(f"basedOnListedRequirements {r['basedOnListedRequirements']}")
    if r["asOf"] != case["asOf"]:
        fail(f"asOf {r['asOf']}")
    if r["sensitiveEvaluated"] is not False:
        fail("sensitiveEvaluated is not false")


def _check_twin(case: Mapping[str, Any], twin: Mapping[str, Any], rule_set: Mapping[str, Any] | None, fail: Any) -> None:
    labelled = case["expect"]
    if _flips(labelled["verdict"], twin["verdict"]):
        fail(f"redacted twin says {twin['verdict']}, labelled {labelled['verdict']}")
    for r in twin["rules"]:
        if r["sensitive"] or r["group"] == "attestations":
            if r["verdict"] != "unknown":
                fail(f"{r['ruleId']} is {r['verdict']} without device answers")
            if r["reasonCode"] not in ("SENSITIVE_ON_DEVICE", "ATTESTATION_ON_DEVICE"):
                fail(f"{r['ruleId']} reason {r['reasonCode']} without device answers")
        elif r["verdict"] != labelled["rules"].get(r["ruleId"]):
            fail(f"{r['ruleId']} is {r['verdict']} in the redacted twin, {labelled['rules'].get(r['ruleId'])} labelled")
    device_only = bool(rule_set) and (any(x["sensitive"] for x in rule_set["rules"]) or bool(rule_set.get("attestations")))
    if device_only and twin["verdict"] == "met":
        fail("redacted twin is met although device-only rules exist")


def _reversed(rule_set: Mapping[str, Any]) -> dict[str, Any]:
    out = dict(rule_set)
    for k in ("rules", "attestations", "anyOf"):
        out[k] = list(reversed(rule_set.get(k, [])))
    return out


def run_golden(golden_dir: Path = GOLDEN_DIR, data_dir: Path = DATA_DIR) -> GoldenReport:
    files, rule_sets_file, snapshot = load_golden(golden_dir, data_dir)
    report = GoldenReport(engine_version=ENGINE_VERSION)
    if not _semver_at_least(ENGINE_VERSION, files["engineMin"]):
        report.failures.append(f"engine {ENGINE_VERSION} is older than the files' engineMin {files['engineMin']}")
    if snapshot.get("engineVersion") != ENGINE_VERSION:
        report.failures.append(f"node-results.json is for engine {snapshot.get('engineVersion')}, catalogue for {ENGINE_VERSION}")

    rule_sets: dict[str, dict[str, Any]] = {}
    for key, entry in rule_sets_file["ruleSets"].items():
        rule_sets[key] = entry["ruleSet"]
        got = compute_rule_set_hash(entry["ruleSet"])
        if got != entry["expectHash"]:
            report.failures.append(f"rule set {key}: hash {got}, expected {entry['expectHash']}")
    report.rule_sets = len(rule_sets)

    results = snapshot.get("results", {})
    seen: set[str] = set()
    for case in files["cases"]:
        cid = case["id"]
        report.cases += 1

        def fail(msg: str, cid: str = cid) -> None:
            report.failures.append(f"case {cid} [{RUNTIME}]: {msg}")

        if cid in seen:
            fail("duplicate case id")
        seen.add(cid)
        rule_set = None if case["ruleSet"] is None else rule_sets.get(case["ruleSet"])
        if case["ruleSet"] is not None and rule_set is None:
            fail(f"unknown rule set {case['ruleSet']}")
            continue
        context = files["contexts"].get(case["context"])
        if context is None:
            fail(f"unknown context {case['context']}")
            continue

        def run(profile: Mapping[str, Any], rs: Mapping[str, Any] | None = rule_set, ctx: Mapping[str, Any] = context, as_of: str = case["asOf"]) -> dict[str, Any]:
            return evaluate_eligibility(rs, profile, as_of, ctx)

        try:
            result = run(case["profile"])
        except Exception as err:  # a crash is a finding, not a test error
            fail(f"raised {type(err).__name__}: {err}")
            continue

        if RUNTIME in case["runtimes"]:
            report.expectations_checked += 1
            _check_expectation(case, result, fail)
        else:
            report.twins_checked += 1
            _check_twin(case, result, rule_set, fail)

        want = results.get(cid)
        if want is None:
            fail("missing from node-results.json")
        elif not same_json(result, want):
            diffs = [k for k in sorted(set(result) | set(want)) if not same_json(result.get(k), want.get(k))]
            fail(f"differs from the Node result in {', '.join(diffs)}")

        before = _verdicts(result)
        for key in list(case["profile"]):
            less = {k: v for k, v in case["profile"].items() if k != key}
            r2 = run(less)
            if _flips(result["verdict"], r2["verdict"]):
                fail(f"forgetting {key} flips the verdict")
            for x in r2["rules"]:
                if _flips(before.get(x["ruleId"]), x["verdict"]):
                    fail(f"forgetting {key} flips {x['ruleId']}")

        if rule_set is not None:
            again = run(case["profile"], _reversed(rule_set))
            if again["verdict"] != result["verdict"] or again["status"] != result["status"] or _verdicts(again) != before:
                fail("result depends on rule order")

    for cid in results:
        if cid not in seen:
            report.failures.append(f"node-results.json has unknown case {cid}")
    return report
