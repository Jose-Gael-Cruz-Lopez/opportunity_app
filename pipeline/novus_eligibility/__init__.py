"""novus_eligibility: the server-safe eligibility engine for the Python pipeline.

A port of shared/eligibility (the TypeScript engine the browser, the Worker and MCP share) for
pipeline-side checks and the release gate. Same results as the Worker, case for case: the golden
runner (golden.py) compares every result with the Node output in data/node-results.json.

Server-safe by construction: there is no parameter for sensitive answers or attestation answers,
and a profile with a sensitive key is refused. Rules on citizenship, Pell, first-generation or
identity, and every attestation, come back unknown, to be checked on the student's device.
"""

from .catalogue import CATALOGUE, ENGINE_VERSION
from .evaluate import SensitiveInputRejectedError, evaluate_eligibility
from .golden import GoldenReport, run_golden
from .hashing import canonical_json, compute_rule_set_hash

__all__ = [
    "CATALOGUE",
    "ENGINE_VERSION",
    "GoldenReport",
    "SensitiveInputRejectedError",
    "canonical_json",
    "compute_rule_set_hash",
    "evaluate_eligibility",
    "run_golden",
]
