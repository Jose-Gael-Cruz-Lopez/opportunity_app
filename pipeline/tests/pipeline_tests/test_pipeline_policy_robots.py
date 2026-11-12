from __future__ import annotations

import pytest

from novus_pipeline.policy import DEFAULT_POLICY, HostPolicy, PolicyEntry
from novus_pipeline.robots import RobotsCache, RobotsRules, parse_retry_after, parse_robots, rules_for_status


@pytest.mark.parametrize(
    ("url", "policy"),
    [
        ("https://www.linkedin.com/jobs/view/1", "never"),
        ("https://linkedin.com/", "never"),
        ("https://x.com/someone", "never"),
        ("https://box.com/", "allowed"),  # suffix match needs a dot boundary
        ("https://eurekahacks.devpost.com/", "manual_only"),
        ("https://foundation.smapply.io/prog/1", "manual_only"),
        ("https://foundation.smapply.ca/prog/1", "manual_only"),
        ("https://foundation.smapply.co.uk/prog/1", "manual_only"),
        ("https://etap.nsf.gov/award/1", "manual_only"),
        ("https://www.nsf.gov/funding/reu", "allowed"),  # etap.nsf.gov leaves the rest of nsf.gov alone
        ("https://docs.google.com/forms/d/e/abc/viewform", "link_only"),
        ("https://docs.google.com/document/d/abc", "allowed"),
        ("https://forms.gle/abc", "link_only"),
        ("https://boards-api.greenhouse.io/v1/boards/x/jobs", "api_only"),
        ("https://www.example.edu/fellowship", "allowed"),
        ("https://EXAMPLE.org./x", "allowed"),
    ],
)
def test_seed_vectors(url: str, policy: str) -> None:
    assert DEFAULT_POLICY.resolve(url).policy == policy


def test_manual_only_hosts_store_no_copy() -> None:
    d = DEFAULT_POLICY.resolve("https://submittable.com/x")
    assert d.copy == "none" and not d.fetchable


def test_longest_match_and_exact_entries() -> None:
    pol = HostPolicy(
        [
            PolicyEntry("example.org", "manual_only"),
            PolicyEntry("api.example.org", "api_only"),
            PolicyEntry("only.example.net", "never", exact=True),
        ]
    )
    assert pol.resolve("https://api.example.org/v1").policy == "api_only"
    assert pol.resolve("https://www.example.org/").policy == "manual_only"
    assert pol.resolve("https://only.example.net/").policy == "never"
    assert pol.resolve("https://sub.only.example.net/").policy == "allowed"


def test_missing_host_is_never() -> None:
    assert DEFAULT_POLICY.resolve("file:///etc/passwd").policy == "never"


ROBOTS = """
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.pdf$
Crawl-delay: 5
Content-Signal: search=yes, ai-train=no, ai-input=no

User-agent: OtherBot
Disallow: /
"""


def test_rfc9309_longest_match_wildcards_and_signals() -> None:
    r = parse_robots(ROBOTS, "NovusBot")
    assert r.allowed("https://example.org/programs")
    assert not r.allowed("https://example.org/private/x")
    assert r.allowed("https://example.org/private/public-page")
    assert not r.allowed("https://example.org/files/guide.pdf")
    assert r.allowed("https://example.org/files/guide.pdf?x=1")  # $ anchors the end
    assert r.allowed("https://example.org/robots.txt")
    assert r.crawl_delay == 5
    assert r.signal_map == {"search": "yes", "ai-train": "no", "ai-input": "no"}


def test_specific_group_wins_and_groups_merge() -> None:
    text = "User-agent: novusbot\nDisallow: /a\n\nUser-agent: *\nDisallow: /\n\nUser-agent: NovusBot\nDisallow: /b\n"
    r = parse_robots(text, "NovusBot")
    assert r.allowed("https://example.org/c")
    assert not r.allowed("https://example.org/a")
    assert not r.allowed("https://example.org/b")


def test_allow_wins_a_tie_and_empty_disallow_allows() -> None:
    assert parse_robots("User-agent: *\nDisallow: /x\nAllow: /x\n", "NovusBot").allowed("https://e.org/x")
    assert parse_robots("User-agent: *\nDisallow:\n", "NovusBot").allowed("https://e.org/anything")


@pytest.mark.parametrize(
    ("status", "state"),
    [(200, "parsed"), (401, "blocked"), (403, "blocked"), (404, "allow_all"), (410, "allow_all"), (429, "unreachable"), (500, "unreachable"), (503, "unreachable")],
)
def test_status_rules_are_stricter_than_the_rfc(status: int, state: str) -> None:
    r = rules_for_status(status, "User-agent: *\nDisallow: /\n", "NovusBot", None, 0.0)
    assert r.state == state
    if state in ("blocked", "unreachable"):
        assert not r.allowed("https://example.org/")


def test_unreachable_is_never_cached_as_allow_all() -> None:
    calls: list[str] = []
    now = [1000.0]

    def loader(origin: str) -> RobotsRules:
        calls.append(origin)
        return RobotsRules("unreachable", retry_after=60, fetched_at=now[0])

    cache = RobotsCache(loader, clock=lambda: now[0])
    assert cache.get("https://e.org").unreachable
    now[0] += 30
    cache.get("https://e.org")
    assert len(calls) == 1  # still inside Retry-After
    now[0] += 31
    cache.get("https://e.org")
    assert len(calls) == 2


def test_retry_after_forms() -> None:
    assert parse_retry_after("120") == 120
    assert parse_retry_after(None) is None
    assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=0) is not None
