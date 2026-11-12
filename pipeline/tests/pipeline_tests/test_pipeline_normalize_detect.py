from __future__ import annotations

from datetime import date

import pytest

from novus_pipeline.detect import ChangeClass, SnapshotFacts, VerifiedQuote, classify_change, triage
from novus_pipeline.normalize import NormalizeError, normalize_html
from novus_pipeline.textnorm import sha256_hex

DEADLINE_Q = "Applications are due Friday, January 15, 2027 at 5:00 PM Eastern Time."
CITIZEN_Q = "Open to U.S. citizens and permanent residents."
TODAY = date(2026, 11, 11)


def facts(raw: bytes) -> SnapshotFacts:
    d = normalize_html(raw)
    return SnapshotFacts(sha256_hex(raw), d.main_text_sha256, d.watch_tokens_sha256)


def classify(base: bytes, cur: bytes, quotes: list[str] | None = None):  # type: ignore[no-untyped-def]
    return classify_change(facts(base), facts(cur), normalize_html(base), normalize_html(cur), quotes or [DEADLINE_Q, CITIZEN_Q])


def test_channels(sample_html: bytes) -> None:
    doc = normalize_html(sample_html, "text/html; charset=utf-8")
    assert doc.title.startswith("Sample Summer Research Fellowship")
    assert CITIZEN_Q in doc.canonical_text  # <details> body stays in canonical text
    assert "Ignore previous instructions" not in doc.canonical_text
    assert "Ignore previous instructions" in doc.hidden_text
    assert "Information sessions" not in doc.canonical_text  # banner is not main content...
    assert "Information sessions" in doc.watch_text  # ...but the watch text sees it
    assert "Home" not in doc.watch_text and "1 Example Way" not in doc.watch_text  # nav and footer
    assert doc.jsonld and doc.jsonld[0]["applicationDeadline"] == "2027-01-15"
    a, b = doc.suspect_ranges[0]
    assert doc.canonical_text[a:b] == "Deadline note for screen readers."


def test_disclosure_widgets_and_aria_hidden() -> None:
    html = b"""<main>
      <button aria-expanded="false" aria-controls="p1">More</button>
      <div id="p1" style="display:none">Panel text revealed on click.</div>
      <div role="tabpanel" hidden>Tab two text.</div>
      <div hidden="until-found">Until found text.</div>
      <div hidden>Truly hidden text.</div>
      <p aria-hidden="true">Decorative but visible text.</p>
      <p style="position:absolute; left:-9999px">Off screen text.</p>
    </main>"""
    doc = normalize_html(html)
    for kept in ("Panel text revealed", "Tab two text.", "Until found text.", "Decorative but visible text."):
        assert kept in doc.canonical_text
    assert "Truly hidden text." in doc.hidden_text and "Off screen text." in doc.hidden_text


def test_whitespace_and_markup_changes_do_not_change_hashes(sample_html: bytes) -> None:
    reformatted = sample_html.replace(b"<p>", b"<p class='x'>\n   ").replace(b"<strong>", b"<em>").replace(b"</strong>", b"</em>")
    a, b = normalize_html(sample_html), normalize_html(reformatted)
    assert a.main_text_sha256 == b.main_text_sha256 and a.key_windows == b.key_windows


def test_volatile_patterns_are_masked(sample_html: bytes) -> None:
    v1 = sample_html.replace(b"</main>", b"<p>Last updated November 3, 2026.</p></main>")
    v2 = sample_html.replace(b"</main>", b"<p>Last updated November 9, 2026.</p></main>")
    mask = [r"Last updated [A-Za-z]+ \d{1,2}, \d{4}\."]
    assert normalize_html(v1, volatile_patterns=mask).main_text_sha256 == normalize_html(v2, volatile_patterns=mask).main_text_sha256
    assert normalize_html(v1).main_text_sha256 != normalize_html(v2).main_text_sha256


def test_empty_documents_raise() -> None:
    with pytest.raises(NormalizeError):
        normalize_html(b"   ")
    with pytest.raises(NormalizeError):
        normalize_html(b"<html><body><script>x()</script></body></html>")


# --- change detection ---------------------------------------------------------------------------


def test_new_none_and_cosmetic(sample_html: bytes) -> None:
    doc = normalize_html(sample_html)
    assert classify_change(None, facts(sample_html), None, doc).cls is ChangeClass.NEW
    assert classify(sample_html, sample_html).cls is ChangeClass.NONE
    cosmetic = sample_html.replace(b'<nav><a href="/">Home</a>', b'<nav><a href="/">Start</a>')
    assert classify(sample_html, cosmetic).cls is ChangeClass.COSMETIC


def test_minor_change_outside_key_windows(sample_html: bytes) -> None:
    # The heading is more than one sentence away from every key sentence.
    minor = sample_html.replace(b"<h1>Sample Summer Research Fellowship</h1>", b"<h1>Welcome to the Sample Summer Research Fellowship</h1>")
    assert classify(sample_html, minor).cls is ChangeClass.MINOR


def test_moved_deadline_is_key_with_token_change_and_missing_quote(sample_html: bytes) -> None:
    moved = sample_html.replace(b"Friday, January 15, 2027", b"Friday, January 8, 2027")
    change = classify(sample_html, moved)
    assert change.cls is ChangeClass.KEY and change.tokens_changed
    assert change.missing_quotes == (DEADLINE_Q,)
    assert any("January 8, 2027" in w for w in change.diff.added)


def test_banner_pause_notice_is_key_even_though_main_text_is_unchanged(sample_html: bytes) -> None:
    paused = sample_html.replace(
        b"Information sessions run every Tuesday in December.", b"Applications for 2027 are paused while we review the program."
    )
    change = classify(sample_html, paused)
    assert change.cls is ChangeClass.KEY and change.tokens_changed


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda h: h.replace(b"<title>Sample", b"<title>Page Not Found - Sample"), "error_title"),
        (lambda h: h.split(b"<main>")[0] + b"<main><h1>Sample</h1></main></body></html>", "main_text_shrank"),
    ],
)
def test_invalid_pages_change_nothing(sample_html: bytes, mutate, reason: str) -> None:  # type: ignore[no-untyped-def]
    change = classify(sample_html, mutate(sample_html))
    assert change.cls is ChangeClass.INVALID and change.invalid_reason == reason


def test_triage_quote_missing_reverifies(sample_html: bytes) -> None:
    reworded = sample_html.replace(b"Open to U.S. citizens and permanent residents.", b"Open to U.S. citizens, nationals and permanent residents.")
    change = classify(sample_html, reworded)
    t = triage(change, [VerifiedQuote("launch_filter", CITIZEN_Q)], TODAY)
    assert (t.task_kind, t.reason, t.reverify, t.urgent) == ("cycle_update", "quote_missing", True, False)


def test_triage_urgent_when_deadline_moves_earlier_within_21_days(sample_html: bytes) -> None:
    moved = sample_html.replace(b"Friday, January 15, 2027", b"Monday, November 23, 2026")
    change = classify(sample_html, moved)
    t = triage(change, [VerifiedQuote("deadline", DEADLINE_Q, "2027-01-15")], TODAY)
    assert t.reason == "urgent_recheck" and t.urgent and t.hold_reminders and t.reverify


def test_triage_urgent_on_new_pause_status(sample_html: bytes) -> None:
    paused = sample_html.replace(b"There is no application fee.", b"There is no application fee. The program is paused for 2027.")
    t = triage(classify(sample_html, paused), [VerifiedQuote("deadline", DEADLINE_Q, "2027-01-15")], TODAY)
    assert t.reason == "urgent_recheck" and "paused" in t.notes


def test_triage_key_change_without_quote_loss(sample_html: bytes) -> None:
    more = sample_html.replace(b"</main>", b"<p>Finalists are notified by March 30, 2027.</p></main>")
    change = classify(sample_html, more)
    assert change.cls is ChangeClass.KEY and not change.missing_quotes
    t = triage(change, [VerifiedQuote("deadline", DEADLINE_Q, "2027-01-15")], TODAY)
    assert t.reason == "key_change" and not t.reverify


def test_triage_pdf_and_quiet_classes() -> None:
    base = SnapshotFacts("a" * 64)
    change = classify_change(base, SnapshotFacts("b" * 64), None, None)
    assert triage(change, [], TODAY, is_pdf=True).reason == "pdf_changed"
    assert triage(classify_change(base, base, None, None), [], TODAY).task_kind is None
