"""Decision-letter check for student uploads (REQ-065), closed results only.

Runs only inside the per-document student sandbox: `check_student_letter`
calls `require_isolation(STUDENT)` before touching any byte and processes
under `deny_network()`. Program, decision and date must be agreed by two
local engines; no LLM is ever used for student content. The result is a
closed object (ids, enums, an ISO date, check codes) with no free text, and
it is scanned against the deny-list before it is returned.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

from .canonical import normalize_for_match
from .config import DEFAULT_CONFIG, DocIntelConfig
from .critical import recognize
from .engines.base import OCREngine
from .errors import DocIntelError, LimitExceeded
from .images import decode_image
from .isolation import DocumentClass, default_network_probe, deny_network, require_isolation
from .privacy import scan
from .reconcile import FieldReading, reconcile_fields

Decision = Literal["accepted", "waitlisted", "rejected"]
LETTER_FIELDS = ("program", "decision", "date")

# Decision cues are phrases addressed to the recipient ("you", "your application"), not words
# that can appear anywhere in a letter: an acceptance often says "unfortunately, we are unable
# to offer housing" or "candidates not selected for the waitlist will be notified". Cues are
# matched on canonical, lower-cased text with whitespace collapsed.
_YOU = r"(?:you|your application|your candidacy)"
_PLACE = r"(?:a |an )?(?:place|position|spot|seat|offer|admission|acceptance|award|fellowship|scholarship|internship|a role)"
STRONG_CUES: tuple[tuple[Decision, tuple[str, ...]], ...] = (
    (
        "rejected",
        (
            rf"\b{_YOU} (?:have|has|were|was) not been (?:selected|accepted|admitted|chosen)\b",
            rf"\b{_YOU} (?:were|was|are|is) not (?:selected|accepted|admitted|chosen|successful)\b",
            r"\byour application (?:was|has been) unsuccessful\b",
            r"\bregret to inform you\b",
            r"\bwe regret that (?:you|we)\b",
            rf"\b(?:unable|not able|cannot|can ?not) (?:to )?offer you {_PLACE}\b",
            rf"\bwill not be (?:able to )?(?:offering|offer) you {_PLACE}\b",
            r"\bnot (?:be )?(?:moving|move) forward with your application\b",
        ),
    ),
    (
        "waitlisted",
        (
            r"\b(?:you|your application) (?:have|has) been (?:placed|put|added) on (?:the|our|a) wait ?(?:ing )?list\b",
            r"\b(?:placed|put|added) (?:you|your application) on (?:the|our|a) wait ?(?:ing )?list\b",
            r"\byou (?:are|remain) on (?:the|our|a) wait ?(?:ing )?list\b",
            r"\byou have been wait ?listed\b",
            r"\byou have been (?:selected|named|chosen) as an alternate\b",
            r"\b(?:placed|put|added) (?:you )?on (?:the|our) alternate list\b",
        ),
    ),
    (
        "accepted",
        (
            # "selected as an alternate" / "for the waitlist" are waitlist cues, and a selection
            # for an interview or a later round is not a decision at all.
            r"\byou have been (?:selected|chosen)(?! as an alternate)(?! for (?:the|our) wait ?(?:ing )?list)"
            r"(?! (?:for|to) (?:an |a )?interview)(?! (?:for|to advance to) the (?:next|second|final|semi-?final) (?:round|stage))"
            r"(?! as a (?:semi-?)?finalist)\b",
            r"\byou have been (?:accepted|admitted|awarded)\b",
            r"\b(?:pleased|delighted|happy|thrilled) to (?:offer you|inform you that you have been (?:selected|accepted|admitted))\b",
            r"\b(?:pleased|delighted|happy|thrilled) to (?:welcome|admit) you\b",
            r"\byour application (?:was|has been) (?:successful|accepted)\b",
        ),
    ),
)
# Used only when no strong cue of any family is present ("Congratulations!" alone).
WEAK_ACCEPT = re.compile(r"\bcongratulations\b")
_COMPILED = tuple((d, tuple(re.compile(p) for p in pats)) for d, pats in STRONG_CUES)

# Cues from two decision families in one letter: the reading is disputed, never guessed.
MIXED: Literal["mixed"] = "mixed"

CheckCode = Literal["fields_agreed", "fields_disputed", "fields_missing", "limit_exceeded", "unreadable"]


class LetterResults(BaseModel):
    """Closed results. No field can carry free text from the letter."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, frozen=True)

    program_id: str | None
    decision: Decision | None
    decision_date: str | None  # ISO YYYY-MM-DD
    check_codes: list[CheckCode]


def decision_cues(text: str) -> set[Decision]:
    """Every decision family with a strong, recipient-addressed cue in the text."""
    low = re.sub(r"\s+", " ", normalize_for_match(text))
    return {decision for decision, patterns in _COMPILED if any(p.search(low) for p in patterns)}


def detect_decision(text: str) -> Decision | Literal["mixed"] | None:
    """The decision the letter states, `mixed` when cues of two families appear, else None."""
    cues = decision_cues(text)
    if len(cues) > 1:
        return MIXED
    if cues:
        return next(iter(cues))
    if WEAK_ACCEPT.search(normalize_for_match(text)):
        return "accepted"
    return None


def detect_program(text: str, programs: Mapping[str, str]) -> str | None:
    """`programs` maps an allow-listed program name to its id.

    A match nested inside a longer match ("Scholars" inside "Summer
    Scholars") is ignored; if two different programs remain, the letter is
    ambiguous and nothing is returned."""
    low = normalize_for_match(text)
    hits: list[tuple[int, int, str]] = []
    for name, program_id in programs.items():
        needle = normalize_for_match(name)
        if not needle:
            continue
        for m in re.finditer(r"(?<!\w)" + re.escape(needle) + r"(?!\w)", low):
            hits.append((m.start(), m.end(), program_id))
    outer = {
        pid for s, e, pid in hits
        if not any(s2 <= s and e <= e2 and (e2 - s2) > (e - s) for s2, e2, _ in hits)
    }
    return next(iter(outer)) if len(outer) == 1 else None


def detect_date(text: str) -> str | None:
    """First fully dated DATE token (a letter date always prints the year)."""
    for token in recognize(text):
        if token.cls == "DATE" and not token.norm.startswith("--"):
            return token.norm
    return None


def extract_letter_fields(text: str, programs: Mapping[str, str]) -> dict[str, FieldReading]:
    return {
        "program": FieldReading(detect_program(text, programs)),
        "decision": FieldReading(detect_decision(text)),
        "date": FieldReading(detect_date(text)),
    }


def decide(engine_texts: Mapping[str, str], programs: Mapping[str, str]) -> LetterResults:
    """Pure decision step: field agreement across engines -> closed results."""
    readings = {engine: extract_letter_fields(text, programs) for engine, text in engine_texts.items()}
    if any(r["decision"].value == MIXED for r in readings.values()):
        # Conflicting cues are a dispute even when every engine read the same words.
        return LetterResults(program_id=None, decision=None, decision_date=None, check_codes=["fields_disputed"])
    decisions = reconcile_fields(readings, LETTER_FIELDS, min_agreeing=2)
    statuses = {d.status for d in decisions.values()}
    if statuses == {"agreed"}:
        prog, dec, date = (decisions[f].value for f in LETTER_FIELDS)
        return LetterResults(
            program_id=prog,
            decision=dec,  # type: ignore[arg-type]  # value comes from STRONG_CUES or WEAK_ACCEPT
            decision_date=date,
            check_codes=["fields_agreed"],
        )
    code: CheckCode = "fields_disputed" if "disputed" in statuses else "fields_missing"
    # Fail closed: nothing partial leaves the sandbox.
    return LetterResults(program_id=None, decision=None, decision_date=None, check_codes=[code])


def check_student_letter(
    image_bytes: Sequence[bytes],
    engines: Sequence[OCREngine],
    programs: Mapping[str, str],
    *,
    config: DocIntelConfig = DEFAULT_CONFIG,
    env: Mapping[str, str] | None = None,
    network_probe: Callable[[], bool] = default_network_probe,
) -> LetterResults:
    """Body of the student sandbox for an `outcome_letter` upload."""
    require_isolation(DocumentClass.STUDENT, env=env, network_probe=network_probe)
    if len(engines) < 2:
        raise DocIntelError("engine_unavailable", detail="two engines required")
    with deny_network():
        if len(image_bytes) > config.limits.max_ocr_pages:
            return LetterResults(program_id=None, decision=None, decision_date=None, check_codes=["limit_exceeded"])
        try:
            images = [decode_image(b, max_megapixels=config.limits.max_image_megapixels) for b in image_bytes]
        except LimitExceeded:
            return LetterResults(program_id=None, decision=None, decision_date=None, check_codes=["limit_exceeded"])
        except DocIntelError:
            return LetterResults(program_id=None, decision=None, decision_date=None, check_codes=["unreadable"])
        texts: dict[str, str] = {}
        for engine in engines:
            parts = [line.text for img in images for line in engine.recognize(img, ["en"]).lines]
            texts[engine.name] = "\n".join(parts)
        results = decide(texts, programs)
    if scan(results):
        raise DocIntelError("deny_list_hit")
    return results
