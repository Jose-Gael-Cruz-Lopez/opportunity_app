from __future__ import annotations

import random

import pytest

from docintel.boxes import Box, iou, merge_line_boxes, pack_char_boxes, union, unpack_char_boxes
from docintel.canonical import canonicalize, canonicalize_string, normalize_for_match
from docintel.config import DEFAULT_CONFIG
from docintel.quality import (
    classify_page,
    cross_reader_agreement,
    document_triage,
    is_garbage_token,
    page_signals,
    quality_score,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ﬁnancial aid", "financial aid"),  # ligature
        ("GPA ３.５", "GPA 3.5"),  # full-width digits
        ("“Apply” ‘now’", "\"Apply\" 'now'"),
        ("2026–2027 — cycle", "2026-2027 - cycle"),
        ("zero​width­soft", "zerowidthsoft"),
        ("non breaking   space", "non breaking space"),
        ("  trim me \n", "trim me"),
        ("line one \r\n  line two", "line one\nline two"),
        ("café", "café"),  # combining mark composed by NFKC
    ],
)
def test_canonical_rules(raw: str, expected: str) -> None:
    assert canonicalize_string(raw).text == expected


def test_ligature_maps_both_chars_to_one_source_index() -> None:
    c = canonicalize_string("ﬁx")
    assert c.text == "fix"
    assert c.src_ranges[:2] == ((0, 1), (0, 1))
    assert c.source_span(0, 2) == (0, 1)


def test_combining_cluster_maps_to_whole_cluster() -> None:
    c = canonicalize_string("ét")
    assert c.text == "ét"
    assert c.src_ranges[0] == (0, 2)


def test_empty_entries_are_skipped() -> None:
    c = canonicalize(["A", "", "B"])
    assert c.text == "AB"
    assert c.src_ranges == ((0, 1), (2, 3))


ALPHABET = list("abc XYZ019-.,") + [" ", "​", "ﬁ", "１", "́", "\n", "—", "“"]


@pytest.mark.parametrize("seed", range(40))
def test_offset_map_is_monotonic_and_total(seed: int) -> None:
    rng = random.Random(seed)
    raw = "".join(rng.choice(ALPHABET) for _ in range(rng.randint(0, 60)))
    c = canonicalize_string(raw)
    assert len(c.src_ranges) == len(c.text)
    starts = [a for a, _ in c.src_ranges]
    assert starts == sorted(starts)
    for a, b in c.src_ranges:
        assert 0 <= a < b <= len(raw)
    # Every visible (non-space, non-zero-width) source char is covered.
    covered = {i for a, b in c.src_ranges for i in range(a, b)}
    for i, ch in enumerate(raw):
        if not ch.isspace() and ch not in "​­" and not (i == 0 and ch == "́"):
            assert i in covered or ch == "́", (raw, i)
    # Idempotent.
    assert canonicalize_string(c.text).text == c.text


def test_normalize_for_match_lowercases() -> None:
    assert normalize_for_match("APPLY Now") == "apply now"


def test_pack_unpack_roundtrip_in_half_points() -> None:
    boxes = [Box(1.0, 2.5, 3.0, 4.5), Box(0, 0, 0, 0), Box(100.25, 200.0, 110.75, 212.0)]
    out = unpack_char_boxes(pack_char_boxes(boxes))
    assert out[0] == Box(1.0, 2.5, 3.0, 4.5)
    assert out[1].empty
    assert out[2].x0 == pytest.approx(100.25, abs=0.25) and out[2].x1 == pytest.approx(110.75, abs=0.25)


def test_pack_clamps_to_int16() -> None:
    (b,) = unpack_char_boxes(pack_char_boxes([Box(0, 0, 20_000, 10)]))
    assert b.x1 == 32767 / 2


def test_merge_line_boxes_and_union() -> None:
    line1 = [Box(0, 10, 5, 20), Box(5, 10, 10, 20), Box(0, 0, 0, 0)]
    line2 = [Box(0, 0, 5, 8)]
    merged = merge_line_boxes(line1 + line2)
    assert merged == [Box(0, 10, 10, 20), Box(0, 0, 5, 8)]
    assert union([]).empty
    assert iou(Box(0, 0, 2, 2), Box(1, 1, 3, 3)) == pytest.approx(1 / 7)


def test_garbage_tokens() -> None:
    assert is_garbage_token("��")
    assert is_garbage_token("abc")
    assert is_garbage_token("%%")
    assert not is_garbage_token("2027")
    assert not is_garbage_token("e-mail")


def test_quality_and_triage_rules() -> None:
    rules = DEFAULT_CONFIG.triage
    good = page_signals("word " * 20, other_reading="word " * 20)
    assert classify_page(good, rules) == "born_digital"
    assert quality_score(good, rules) == 1.0
    assert classify_page(page_signals(""), rules) == "blank"
    assert classify_page(page_signals("", has_images=True), rules) == "failing"
    drift = page_signals("word " * 20, other_reading="wxrd " * 20)
    assert quality_score(drift, rules) < 0.8
    assert document_triage(["born_digital", "blank"]) == "born_digital"
    assert document_triage(["blank"]) == "no_text_layer"
    assert document_triage(["born_digital", "failing"]) == "no_text_layer"
    assert cross_reader_agreement("a b c", "abc") == 1.0
