"""Canonical JSON and the rule-set hash, matching shared/eligibility/hash.ts and versioning.ts.

Canonical form: keys sorted, no whitespace, strings escaped as JSON.stringify does, numbers in
ECMAScript shortest form (an integral float prints without a fraction, 4.0 -> "4").
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Mapping

from .values import js_number_text


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if type(value) in (int, float):
        if type(value) is float and not math.isfinite(value):
            raise ValueError("canonical JSON has no NaN or Infinity")
        return js_number_text(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, Mapping):
        keys = sorted(value.keys())
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(value[k])}" for k in keys) + "}"
    raise TypeError(f"canonical JSON cannot encode {type(value).__name__}")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


HASH_KEYS = ("format", "coverage", "rules", "anyOf", "attestations", "nomination")


def hash_body(rule_set: Mapping[str, Any]) -> dict[str, Any]:
    # An absent key is JavaScript's undefined, which canonical JSON drops.
    return {k: rule_set[k] for k in HASH_KEYS if k in rule_set}


def compute_rule_set_hash(rule_set: Mapping[str, Any]) -> str:
    """sha256 over the canonical JSON of the hash body, as computeRuleSetHash does."""
    return sha256_hex(canonical_json(hash_body(rule_set)))
