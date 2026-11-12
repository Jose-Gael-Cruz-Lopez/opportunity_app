from __future__ import annotations

import socket
from collections.abc import Sequence

import pytest
from docintel_fakes import FakeEngine, blank_png, line
from PIL import Image

from docintel.engines.base import EngineResult
from docintel.errors import IsolationViolation, NetworkDenied
from docintel.letters import (
    LetterResults,
    check_student_letter,
    decide,
    detect_decision,
    detect_date,
    detect_program,
)
from docintel.privacy import scan

from conftest import blocked_probe

# Sample allow-list; names are invented for tests and are not real programs.
PROGRAMS = {"Sample Summer Scholars": "prog_sample_1", "Sample Scholars": "prog_sample_2"}
LETTER = [
    "March 1, 2027",
    "Dear [name removed],",
    "Congratulations! You have been selected for the Sample Summer Scholars program.",
]


def run(engines, images=None, env=None):  # type: ignore[no-untyped-def]
    return check_student_letter(
        images or [blank_png()],
        engines,
        PROGRAMS,
        env=env if env is not None else {"NOVUS_DOCINTEL_RUNTIME": "student_sandbox"},
        network_probe=blocked_probe,
    )


def engines_for(a: Sequence[str], b: Sequence[str]) -> list[FakeEngine]:
    return [
        FakeEngine("tesseract", [line(t, 0.1 * i) for i, t in enumerate(a)]),
        FakeEngine("paddleocr", [line(t, 0.1 * i) for i, t in enumerate(b)]),
    ]


def test_detectors() -> None:
    assert detect_decision("We regret that you have not been selected") == "rejected"
    assert detect_decision("You are on the waitlist") == "waitlisted"
    assert detect_decision("Congratulations!") == "accepted"
    assert detect_decision("Thank you for applying") is None
    assert detect_program("the Sample Summer Scholars program", PROGRAMS) == "prog_sample_1"
    assert detect_program("Sample Scholars", PROGRAMS) == "prog_sample_2"
    assert detect_program("nothing here", PROGRAMS) is None
    assert detect_program("Alpha and Beta", {"Alpha": "a", "Beta": "b"}) is None  # ambiguous
    assert detect_date("Sent March 1 and dated March 2, 2027") == "2027-03-02"


# Realistic acceptance letters with caveats: generic words such as "unfortunately" or a bare
# "not selected" must not flip the decision.
@pytest.mark.parametrize(
    "text",
    [
        "Congratulations! You have been selected for the Summer Scholars program. Unfortunately, we are unable to offer housing.",
        "You have been selected. Note: candidates not selected for the waitlist will be notified separately.",
        "We are pleased to offer you a place in the program. Unfortunately, we are unable to offer you housing this year.",
        "Dear [name removed], you have been accepted. Applicants who were not selected have been notified; we regret any delay.",
    ],
)
def test_acceptances_with_caveats_stay_accepted(text: str) -> None:
    assert detect_decision(text) == "accepted"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Congratulations on reaching the final round. Unfortunately, you were not selected for the program.", "rejected"),
        ("We are unable to offer you a place in this year's cohort.", "rejected"),
        ("You have been selected as an alternate.", "waitlisted"),
        ("You have been selected for an interview on March 3.", None),
        ("Unfortunately, the program start date has moved.", None),
    ],
)
def test_decisions_come_from_recipient_addressed_cues(text: str, expected: str | None) -> None:
    assert detect_decision(text) == expected


def test_conflicting_cues_are_disputed_even_when_engines_agree() -> None:
    mixed = [LETTER[0], "Congratulations! You have been selected for the Sample Summer Scholars program.",
             "We regret to inform you that you have not been selected for housing."]
    assert detect_decision("\n".join(mixed)) == "mixed"
    out = run(engines_for(mixed, mixed))
    assert out == LetterResults(program_id=None, decision=None, decision_date=None, check_codes=["fields_disputed"])


def test_agreeing_engines_produce_closed_results() -> None:
    out = run(engines_for(LETTER, LETTER))
    assert out == LetterResults(program_id="prog_sample_1", decision="accepted", decision_date="2027-03-01",
                                check_codes=["fields_agreed"])
    assert scan(out) == []


def test_any_disagreement_fails_closed_with_nothing_partial() -> None:
    misread = [LETTER[0].replace("1, 2027", "7, 2027"), *LETTER[1:]]
    out = run(engines_for(LETTER, misread))
    assert out == LetterResults(program_id=None, decision=None, decision_date=None, check_codes=["fields_disputed"])


def test_missing_field_fails_closed() -> None:
    no_date = LETTER[1:]
    assert run(engines_for(no_date, no_date)).check_codes == ["fields_missing"]


def test_results_model_is_closed() -> None:
    with pytest.raises(Exception):
        LetterResults.model_validate({"program_id": None, "decision": None, "decision_date": None,
                                      "check_codes": [], "text": "free text"})
    with pytest.raises(Exception):
        LetterResults.model_validate({"program_id": None, "decision": "maybe", "decision_date": None,
                                      "check_codes": []})


def test_refuses_to_run_outside_the_student_sandbox() -> None:
    for env in ({"NOVUS_DOCINTEL_RUNTIME": "ocr_image"}, {"NOVUS_DOCINTEL_RUNTIME": "parse_pdf"}, {}):
        with pytest.raises(IsolationViolation):
            run(engines_for(LETTER, LETTER), env=env)


class PhoningHomeEngine:
    name = "evil"
    version = "1"

    def recognize(self, image: Image.Image, langs: Sequence[str]) -> EngineResult:
        socket.create_connection(("192.0.2.1", 443))
        raise AssertionError("unreachable")


def test_engine_code_cannot_open_a_connection() -> None:
    with pytest.raises(NetworkDenied):
        run([PhoningHomeEngine(), PhoningHomeEngine()])


def test_limits_and_unreadable_images() -> None:
    assert run(engines_for(LETTER, LETTER), images=[blank_png()] * 11).check_codes == ["limit_exceeded"]
    assert run(engines_for(LETTER, LETTER), images=[b"not an image"]).check_codes == ["unreadable"]


def test_decide_is_pure() -> None:
    out = decide({"a": "\n".join(LETTER), "b": "\n".join(LETTER)}, PROGRAMS)
    assert out.decision == "accepted"
