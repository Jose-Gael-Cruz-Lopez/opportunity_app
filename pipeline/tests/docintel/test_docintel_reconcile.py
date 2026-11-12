from __future__ import annotations

import pytest
from docintel_fakes import line, result

from docintel.config import DEFAULT_CONFIG
from docintel.contracts import TextLayerPage
from docintel.reconcile import FieldReading, check_page, reconcile_fields


def tokens_by_class(page, cls):  # type: ignore[no-untyped-def]
    return [t for t in page.tokens if t.cls == cls]


def test_agreed_disputed_and_single_tokens() -> None:
    tess = result(
        "tesseract",
        [
            line("Deadline March 30, 2027 at 5:00 PM ET", 0.10, 0.95),
            line("Apply at go1dwater.gov/apply", 0.20, 0.80),
            line("Stipend $7,500", 0.30, 0.9),
        ],
    )
    paddle = result(
        "paddleocr",
        [
            line("Deadline March 30, 2027 at 5:00 PM ET", 0.101, 0.91),
            line("Apply at goldwater.gov/apply", 0.201, 0.97),
            line("Questions: help@example.org", 0.50, 0.88),
        ],
    )
    page = check_page(1, tess, paddle, DEFAULT_CONFIG)

    date = tokens_by_class(page, "DATE")[0]
    assert date.agreement == "agreed"
    assert date.norm == "2027-03-30"
    assert date.readers == ["tesseract", "paddleocr"]
    assert date.confidence == pytest.approx(0.91)  # min of the two readers
    assert page.text[date.start:date.end] == "March 30, 2027"

    time = tokens_by_class(page, "TIME")[0]
    assert time.agreement == "agreed" and time.norm == "17:00 ET"

    url = tokens_by_class(page, "URL")[0]
    assert url.agreement == "disputed"
    assert {r.text for r in url.readings} == {"go1dwater.gov/apply", "goldwater.gov/apply"}
    assert url.confidence is None

    money = tokens_by_class(page, "NUMBER")
    assert money[0].agreement == "single" and money[0].readers == ["tesseract"]
    email = tokens_by_class(page, "EMAIL")[0]
    assert email.agreement == "single" and email.readers == ["paddleocr"]
    assert page.text[email.start:email.end] == "help@example.org"


def test_page_text_is_primary_reading_in_reading_order() -> None:
    tess = result("tesseract", [line("Second line", 0.3), line("First line", 0.1)])
    paddle = result("paddleocr", [line("First 1ine", 0.1), line("Only paddle", 0.5)])
    page = check_page(2, tess, paddle, DEFAULT_CONFIG)
    assert page.text == "First line\nSecond line\nOnly paddle"


def test_token_missing_on_one_side_is_disputed() -> None:
    tess = result("tesseract", [line("Due March 30 2027 noon", 0.1)])
    paddle = result("paddleocr", [line("Due March 30 2027 n00n", 0.1)])
    page = check_page(1, tess, paddle, DEFAULT_CONFIG)
    time = tokens_by_class(page, "TIME")[0]
    assert time.agreement == "disputed"
    assert [r.reader for r in time.readings] == ["tesseract"]


def test_token_only_secondary_saw_is_anchored_to_the_line() -> None:
    tess = result("tesseract", [line("Due by 5 PM", 0.1)])
    paddle = result("paddleocr", [line("Due Apr 2 by 5 PM", 0.1)])
    page = check_page(1, tess, paddle, DEFAULT_CONFIG)
    date = tokens_by_class(page, "DATE")[0]
    assert date.agreement == "disputed"
    assert (date.start, date.end) == (0, len("Due by 5 PM"))


def test_agreed_box_is_union_of_both_readers() -> None:
    tess = result("tesseract", [line("Due March 30, 2027", 0.10, x0=0.10, x1=0.50)])
    paddle = result("paddleocr", [line("Due March 30, 2027", 0.10, x0=0.12, x1=0.52)])
    date = check_page(1, tess, paddle, DEFAULT_CONFIG).tokens[0]
    assert date.box.x0 == pytest.approx(0.10 + 0.40 * 4 / 18)
    assert date.box.x1 == pytest.approx(0.52)


def test_layer_page_and_reports_validate() -> None:
    tess = result("tesseract", [line("Apply at go1dwater.gov by March 30, 2027", 0.1)])
    paddle = result("paddleocr", [line("Apply at goldwater.gov by March 30, 2027", 0.1)])
    page = check_page(3, tess, paddle, DEFAULT_CONFIG)
    lp = page.to_layer_page()
    TextLayerPage.model_validate(lp.to_wire())
    disputed = [t for t in lp.tokens or [] if t.agreement == "disputed"]
    agreed = [t for t in lp.tokens or [] if t.agreement == "agreed"]
    assert disputed[0].readings is not None and len(disputed[0].readings) == 2
    assert agreed[0].readings is None
    reports = page.reports()
    assert {r.page for r in reports} == {3}
    assert all(0 <= r.bbox.x0 <= r.bbox.x1 <= 1 for r in reports)


def test_reconcile_fields_rules() -> None:
    a = {"program": FieldReading("p1"), "decision": FieldReading("accepted", conf=0.9), "date": FieldReading(None)}
    b = {"program": FieldReading("p1"), "decision": FieldReading("accepted", conf=0.8), "date": FieldReading("2027-03-01")}
    out = reconcile_fields({"tesseract": a, "paddleocr": b}, ["program", "decision", "date", "other"])
    assert out["program"].status == "agreed" and out["program"].value == "p1"
    assert out["decision"].confidence == pytest.approx(0.8)
    assert out["date"].status == "single"
    assert out["other"].status == "missing"


def test_third_engine_vetoes_but_never_outvotes() -> None:
    a = {"date": FieldReading("2027-03-01")}
    b = {"date": FieldReading("2027-03-01")}
    c = {"date": FieldReading("2027-08-01")}
    out = reconcile_fields({"a": a, "b": b, "c": c}, ["date"])
    assert out["date"].status == "disputed" and out["date"].value is None
