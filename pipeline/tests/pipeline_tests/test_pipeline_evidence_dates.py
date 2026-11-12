"""Evidence vectors (plan 8.6 / S08-012) and span-parser golden tests (S04-030)."""

from __future__ import annotations

from datetime import date

import pytest

from novus_pipeline.dates import find_zone, parse_deadline
from novus_pipeline.evidence import EvidenceText, FieldKind, check_deadline, check_leaf, locate

REF = date(2026, 11, 11)
PAGE = "\n".join(
    [
        "Applications are due January 15, 2027 at 5:00 PM Central Time.",
        "U.S. citizens, U.S. nationals and permanent residents of the United States are not eligible to apply for this program.",
        "Students who are ineligible for federal aid may apply.",
        "Applicants must have a GPA of at least 3.0 before the program starts.",
        "Apply at https://apply.example.org/fellowship/2027.",
        "Fellows receive a stipend of $6,500.",
        "Program dates: June 1, 2027.",
        "Info session: June 1, 2027.",
    ]
)
SRC = EvidenceText(PAGE)


@pytest.mark.parametrize(
    "altered",
    [
        "Applications are due January 16, 2027 at 5:00 PM Central Time.",  # one digit
        "Applications are due January 15, 2027 at 5:00 AM Central Time.",  # AM/PM
        "Applications are due January 15, 2027 at 5:00 PM Eastern Time.",  # zone swap
        "U.S. citizens, U.S. nationals and permanent residents of the United States are eligible to apply for this program.",  # dropped "not"
        "Students who are eligible for federal aid may apply.",  # ineligible -> eligible
        "Applicants must have a GPA of at most 3.0 before the program starts.",  # at least -> at most
        "Applicants must have a GPA of at least 3.0 after the program starts.",  # before -> after
        "Apply at https://apply.example.org/fellowship/2026.",  # URL path
        "Fellows receive a stipend of $6,000.",  # amount
    ],
)
def test_altered_quotes_never_pass(altered: str) -> None:
    loc = locate(SRC, altered, FieldKind.TEXT)
    assert loc.blocked and loc.code in ("QUOTE_ALTERED", "QUOTE_NOT_ON_PAGE")


def test_inserted_only_is_altered() -> None:
    src = EvidenceText("Students from community colleges may apply.")
    assert locate(src, "Only students from community colleges may apply.", FieldKind.TEXT).blocked


def test_formatting_differences_align() -> None:
    loc = locate(SRC, "applications are due January 15, 2027 at 5:00 PM Central Time", FieldKind.TEXT)
    assert loc.method == "aligned"
    assert PAGE[loc.start : loc.end].startswith("Applications are due")


def test_eligibility_needs_an_exact_match() -> None:
    loc = locate(SRC, "students who are ineligible for federal aid may apply", FieldKind.ELIGIBILITY)
    assert loc.blocked and loc.code == "QUOTE_ALTERED"
    assert locate(SRC, "Students who are ineligible for federal aid may apply.", FieldKind.ELIGIBILITY).method == "exact"


def test_short_quote_repeated_across_sections_is_ambiguous() -> None:
    loc = locate(SRC, "June 1, 2027", FieldKind.DATE)
    assert loc.method == "exact" and "AMBIGUOUS_QUOTE" in loc.flags


def test_hidden_only_and_watch_channels() -> None:
    src = EvidenceText("Main text.", watch="Deadline extended to February 1, 2027.", hidden="Secret deadline March 1, 2027.")
    assert locate(src, "Secret deadline March 1, 2027.", FieldKind.TEXT).code == "HIDDEN_TEXT"
    assert locate(src, "Deadline extended to February 1, 2027.", FieldKind.TEXT).code == "QUOTE_NOT_ON_PAGE"
    curator = locate(src, "Deadline extended to February 1, 2027.", FieldKind.TEXT, allow_watch=True)
    assert curator.method == "exact" and curator.channel == "watch"


def test_suspect_markup_flags() -> None:
    src = EvidenceText("Visible. Deadline is May 1, 2027.", suspect_ranges=((9, 33),))
    assert "HIDDEN_TEXT_SUSPECT" in locate(src, "Deadline is May 1, 2027.", FieldKind.TEXT).flags


def test_leaf_values_are_parsed_from_the_page() -> None:
    ok = check_leaf(SRC, "stipend", "$6,500", "Fellows receive a stipend of $6,500.", "found", FieldKind.AMOUNT, REF)
    assert ok.parsed_value == "650000" and "VALUE_NOT_IN_SPAN" not in ok.flags
    wrong = check_leaf(SRC, "stipend", "$7,000", "Fellows receive a stipend of $6,500.", "found", FieldKind.AMOUNT, REF)
    assert "VALUE_NOT_IN_SPAN" in wrong.flags and wrong.parsed_value == "650000"
    url = check_leaf(SRC, "application_url", "https://apply.example.org/fellowship/2027", "Apply at https://apply.example.org/fellowship/2027.", "found", FieldKind.URL, REF)
    assert url.parsed_value == "https://apply.example.org/fellowship/2027" and not url.flags


def test_not_stated_rules() -> None:
    assert check_leaf(SRC, "f", "", "", "not_stated", FieldKind.TEXT, REF).outcome == "not_stated"
    assert check_leaf(SRC, "f", "x", "", "not_stated", FieldKind.TEXT, REF).code == "NOT_STATED_WITH_VALUE"


def test_eligibility_polarity_review() -> None:
    c = check_leaf(SRC, "e", "x", "Students who are ineligible for federal aid may apply.", "found", FieldKind.ELIGIBILITY, REF)
    assert "POLARITY_REVIEW" in c.flags


def test_deadline_item_checks() -> None:
    q = "Applications are due January 15, 2027 at 5:00 PM Central Time."
    good = check_deadline(SRC, "d0", quote=q, status="found", local_date="2027-01-15", local_time="17:00", tz_mode="fixed", fetched_at=REF)
    assert good.outcome == "exact" and not good.flags
    assert good.parsed_deadline and good.parsed_deadline.time_zone == "America/Chicago"
    wrong = check_deadline(SRC, "d0", quote=q, status="found", local_date="2027-01-16", local_time="5 pm", tz_mode="fixed", fetched_at=REF)
    assert "VALUE_NOT_IN_SPAN" in wrong.flags
    info = check_deadline(SRC, "d1", quote="Info session: June 1, 2027.", status="found", local_date="2027-06-01", local_time="", tz_mode="not_stated", fetched_at=REF)
    assert "KIND_UNSUPPORTED" in info.flags and "TZ_MISSING" in info.flags


# --- span parser golden rows ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("sentence", "local_date", "local_time", "zone", "mode"),
    [
        ("Applications are due January 15, 2027 at 5:00 PM ET.", "2027-01-15", "17:00", "America/New_York", "fixed"),
        ("Deadline: Feb. 3, 2027, 11:59 p.m. Central.", "2027-02-03", "23:59", "America/Chicago", "fixed"),
        ("Submit by 1/31/2027 at noon MST.", "2027-01-31", "12:00", "America/Denver", "fixed"),
        ("Due 15 March 2027, 9am Pacific Time.", "2027-03-15", "09:00", "America/Los_Angeles", "fixed"),
        ("Applications close March 1, 2027 at 11:59 PM Alaska Time.", "2027-03-01", "23:59", "America/Anchorage", "fixed"),
        ("Applications close March 1, 2027 at 11:59 PM HST.", "2027-03-01", "23:59", "Pacific/Honolulu", "fixed"),
        ("Applications close March 1, 2027 at 11:59 PM Samoa Time.", "2027-03-01", "23:59", "Pacific/Pago_Pago", "fixed"),
        ("Applications close March 1, 2027 at 11:59 PM Atlantic Time.", "2027-03-01", "23:59", "America/Puerto_Rico", "fixed"),
        ("Applications close March 1, 2027 at 11:59 PM AoE.", "2027-03-01", "23:59", "Etc/GMT+12", "fixed"),
        ("Applications are due February 1, 2027, 11:59 pm, your time zone.", "2027-02-01", "23:59", None, "applicant_local"),
        ("Applications open Dec 1, 2026 and close Jan 20, 2027.", "2027-01-20", None, None, None),
        ("Applications are due in March 2027.", "2027-03", None, None, None),
        ("Submit by 2027-04-02 17:00 UTC.", "2027-04-02", "17:00", "UTC", "fixed"),
    ],
)
def test_deadline_grammar(sentence: str, local_date: str, local_time: str | None, zone: str | None, mode: str | None) -> None:
    p = parse_deadline(sentence, reference=REF)
    assert p is not None
    assert (p.local_date, p.local_time, p.time_zone, p.tz_mode) == (local_date, local_time, zone, mode)


def test_year_inference_weekday_mismatch_and_midnight() -> None:
    p = parse_deadline("Applications are due January 15 at 5 PM ET.", reference=REF)
    assert p and p.local_date == "2027-01-15" and p.year_inferred
    w = parse_deadline("Applications are due Thursday, January 15, 2027.", reference=REF)
    assert w and w.weekday_mismatch  # 15 Jan 2027 is a Friday
    m = parse_deadline("Applications are due at midnight on January 15, 2027 ET.", reference=REF)
    assert m and m.local_time == "23:59" and m.time_ambiguous


def test_zone_words_need_capitals_for_abbreviations() -> None:
    assert find_zone("a meeting in Hartford, et al.") is None
    zone = find_zone("5 PM ET")
    assert zone is not None and zone.iana == "America/New_York"
