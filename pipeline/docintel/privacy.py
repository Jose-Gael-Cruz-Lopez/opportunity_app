"""Deny-list scan for anything that leaves a student-document sandbox.

The sandbox returns a closed results object with no free text, and this scan
is defense in depth on top of that (plan 5.8). It mirrors the Worker's
completion scan: case-sensitive word-boundary patterns for short tokens,
A-numbers, and case-insensitive phrases for status and identity terms.

The full vocabulary is owned by `shared/eligibility/sensitive.ts`; this list
is DocIntel's matching-pattern subset and must stay a superset of the
Worker's short-token rules. Rule ids, never matched text, are reported.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from pydantic import BaseModel


@dataclass(frozen=True)
class DenyRule:
    rule_id: str
    pattern: re.Pattern[str]


_SHORT = {
    "tps": r"\bTPS\b",
    "sai": r"\bSAI\b",
    "f1": r"\bF-1\b",
    "j1": r"\bJ-1\b",
    "i20": r"\bI-20\b",
    "daca": r"\bDACA\b",
}
_PHRASES = {
    "citizenship": r"\bcitizen(ship)?\b",
    "immigration": r"\bimmigra(nt|tion)\b",
    "visa": r"\bvisa\b",
    "undocumented": r"\bundocumented\b",
    "refugee": r"\brefugee\b",
    "asylee": r"\basyl(ee|um)\b",
    "permanent_resident": r"\bpermanent\s+resident\b",
    "green_card": r"\bgreen\s+card\b",
    "pell": r"\bpell\b",
    "first_generation": r"\bfirst[-\s]generation\b",
    "disability": r"\bdisab(led|ility)\b",
    "race_ethnicity": r"\b(race|ethnicity|hispanic|latin[oax]|african\s+american)\b",
    "gender_identity": r"\b(gender\s+identity|transgender|non[-\s]?binary)\b",
    "sexual_orientation": r"\b(sexual\s+orientation|lgbtq\+?|gay|lesbian|bisexual)\b",
    "religion": r"\breligio(n|us)\b",
    "tribal": r"\b(tribal\s+(enrollment|affiliation)|cdib)\b",
    "veteran": r"\b(veteran|military\s+service)\b",
    "foster_care": r"\bfoster\s+care\b",
    "income": r"\b(household\s+income|low[-\s]income)\b",
}

RULES: tuple[DenyRule, ...] = (
    *(DenyRule(f"short:{k}", re.compile(v)) for k, v in _SHORT.items()),
    DenyRule("a_number", re.compile(r"\bA-?\d{8,9}\b")),
    *(DenyRule(f"phrase:{k}", re.compile(v, re.IGNORECASE)) for k, v in _PHRASES.items()),
)


def iter_strings(value: object) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, BaseModel):
        yield from iter_strings(value.model_dump(mode="json"))
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from iter_strings(v)
    elif isinstance(value, (list, tuple, set, frozenset)):
        for v in value:
            yield from iter_strings(v)


def scan(value: object) -> list[str]:
    """Rule ids that match any string inside `value` (keys included)."""
    hits: set[str] = set()
    for s in iter_strings(value):
        for rule in RULES:
            if rule.pattern.search(s):
                hits.add(rule.rule_id)
    return sorted(hits)
