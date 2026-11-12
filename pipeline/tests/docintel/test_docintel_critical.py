from __future__ import annotations

import itertools
import random

import pytest

from docintel.critical import normalize_as, recognize
from docintel.matching import hungarian, match_lines
from docintel.boxes import Box


def classes(text: str) -> list[tuple[str, str]]:
    return [(t.cls, t.norm) for t in recognize(text)]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Due March 30, 2027", [("DATE", "2027-03-30")]),
        ("Due Mar. 30", [("DATE", "--03-30")]),
        ("Due 30 March 2027", [("DATE", "2027-03-30")]),
        ("Due 3/30/2027", [("DATE", "2027-03-30")]),
        ("Due 3/30/27", [("DATE", "2027-03-30")]),
        ("Due 2027-03-30", [("DATE", "2027-03-30")]),
        ("Due 13/45/2027", [("NUMBER", "13"), ("NUMBER", "45"), ("NUMBER", "2027")]),
        ("by 5:00 PM ET", [("TIME", "17:00 ET")]),
        ("by 5pm Eastern Time", [("TIME", "17:00 ET")]),
        ("by 11:59 p.m. PST", [("TIME", "23:59 PT")]),
        ("at 17:00", [("TIME", "17:00")]),
        ("by noon CT", [("TIME", "12:00 CT")]),
        ("Visit https://Example.ORG/Apply.", [("URL", "https://example.org/Apply")]),
        ("Visit goldwater.gov/apply", [("URL", "goldwater.gov/apply")]),
        ("Email Help@Example.ORG.", [("EMAIL", "Help@example.org")]),
        ("Stipend $5,000", [("NUMBER", "5000")]),
        ("Minimum GPA 3.5", [("NUMBER", "3.5")]),
        ("Open to first-year students", [("ELIG_TERM", "first year")]),
        ("U.S. citizens or permanent residents", [("ELIG_TERM", "us citizens"), ("ELIG_TERM", "permanent residents")]),
        ("Pell Grant recipients", [("ELIG_TERM", "pell grant")]),
    ],
)
def test_recognizers(text: str, expected: list[tuple[str, str]]) -> None:
    assert classes(text) == expected


def test_no_fuzzy_matching_on_urls() -> None:
    assert normalize_as("URL", "goldwater.gov") != normalize_as("URL", "go1dwater.gov")


def test_digits_inside_dates_and_urls_are_not_numbers() -> None:
    found = classes("Apply by April 2, 2027 at example.org/2027 and pay $40")
    assert [c for c, _ in found] == ["DATE", "URL", "NUMBER"]


def test_email_domain_is_not_a_url() -> None:
    assert [c for c, _ in classes("write to info@example.edu")] == ["EMAIL"]


def test_offsets_point_at_printed_text() -> None:
    text = "Due March 30, 2027 at 5 PM ET"
    for t in recognize(text):
        assert text[t.start:t.end] == t.text


def test_normalize_as_requires_exactly_one_token_of_the_class() -> None:
    assert normalize_as("DATE", " March 30, 2027 ") == "2027-03-30"
    assert normalize_as("DATE", "5 PM") is None
    assert normalize_as("DATE", "March 3 and March 4") is None


def brute_force(cost: list[list[float]]) -> float:
    n, m = len(cost), len(cost[0])
    if n <= m:
        return min(sum(cost[i][p[i]] for i in range(n)) for p in itertools.permutations(range(m), n))
    return min(sum(cost[p[j]][j] for j in range(m)) for p in itertools.permutations(range(n), m))


@pytest.mark.parametrize("seed", range(25))
def test_hungarian_is_optimal(seed: int) -> None:
    rng = random.Random(seed)
    n, m = rng.randint(1, 5), rng.randint(1, 5)
    cost = [[rng.random() for _ in range(m)] for _ in range(n)]
    pairs = hungarian(cost)
    assert len(pairs) == min(n, m)
    assert len({i for i, _ in pairs}) == len(pairs) and len({j for _, j in pairs}) == len(pairs)
    assert sum(cost[i][j] for i, j in pairs) == pytest.approx(brute_force(cost))


def test_match_lines_releases_low_iou_pairs() -> None:
    a = [Box(0, 0, 1, 0.1), Box(0, 0.5, 1, 0.6)]
    b = [Box(0, 0.01, 1, 0.11), Box(0, 0.9, 1, 1.0)]
    m = match_lines(a, b, min_iou=0.3)
    assert m.pairs == [(0, 0)]
    assert m.lone_a == [1] and m.lone_b == [1]
    assert match_lines([], b, min_iou=0.3).lone_b == [0, 1]
