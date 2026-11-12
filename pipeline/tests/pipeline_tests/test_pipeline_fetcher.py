from __future__ import annotations

import gzip

import httpx
import pytest
import respx

from novus_pipeline.config import HTML_CAP_BYTES
from novus_pipeline.fetcher import FetchRequest, Fetcher
from novus_pipeline.limiter import HostHealth, HostLimiter
from novus_pipeline.netguard import AddressGuard

UA = "NovusBot/1.0 (+https://novus.example/bot)"
PUBLIC = {"www.example.org": ["93.184.215.14"], "apply.example.org": ["93.184.215.15"], "evil.example.org": ["10.0.0.7"]}


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0
        self.slept: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def fetcher(clock: FakeClock) -> Fetcher:
    client = httpx.Client(headers={"User-Agent": UA, "From": "crawler@novus.example"}, follow_redirects=False, trust_env=False)
    guard = AddressGuard(resolver=lambda h, p: PUBLIC.get(h, ["93.184.215.99"]))
    return Fetcher(
        client,
        guard=guard,
        limiter=HostLimiter(clock=clock.now, sleep=clock.sleep),
        health=HostHealth(clock=clock.now),
        sleep=clock.sleep,
    )


def robots_ok(router: respx.MockRouter, host: str = "www.example.org", body: str = "User-agent: *\nAllow: /\n") -> respx.Route:
    return router.get(f"https://{host}/robots.txt").mock(return_value=httpx.Response(200, text=body))


def test_fetches_with_identity_headers_and_hashes(fetcher: Fetcher, sample_html: bytes) -> None:
    with respx.mock(assert_all_called=True) as router:
        robots_ok(router)
        page = router.get("https://www.example.org/fellowship").mock(
            return_value=httpx.Response(200, content=sample_html, headers={"content-type": "text/html; charset=utf-8", "etag": '"v1"'})
        )
        check = fetcher.fetch(FetchRequest("https://www.example.org/fellowship"))
    assert check.outcome == "ok" and check.etag == '"v1"' and check.body == sample_html
    assert len(check.raw_sha256 or "") == 64
    sent = page.calls[0].request
    assert sent.headers["user-agent"] == UA and sent.headers["from"] == "crawler@novus.example"
    assert "body" not in check.summary()


def test_conditional_request_and_304(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        page = router.get("https://www.example.org/p").mock(return_value=httpx.Response(304))
        check = fetcher.fetch(FetchRequest("https://www.example.org/p", etag='"v1"', last_modified="Tue, 10 Nov 2026 08:00:00 GMT"))
    assert check.outcome == "not_modified"
    assert page.calls[0].request.headers["if-none-match"] == '"v1"'
    assert page.calls[0].request.headers["if-modified-since"].startswith("Tue")


@pytest.mark.parametrize("url", ["https://www.linkedin.com/jobs/1", "https://foo.submittable.com/x", "https://forms.gle/abc"])
def test_never_manual_and_link_only_hosts_get_no_request_at_all(fetcher: Fetcher, url: str) -> None:
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        check = fetcher.fetch(FetchRequest(url))
        assert router.calls.call_count == 0
    assert check.outcome == "skipped" and (check.reason or "").startswith("host_policy")


def test_api_only_hosts_only_for_api_sources(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        check = fetcher.fetch(FetchRequest("https://api.nsf.gov/services/v1/awards.json"))
        assert router.calls.call_count == 0
    assert check.reason == "host_policy:api_only"


def test_redirect_to_a_manual_only_host_is_stopped_before_requesting_it(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        robots_ok(router)
        router.get("https://www.example.org/apply").mock(
            return_value=httpx.Response(302, headers={"location": "https://foundation.smapply.io/prog/7"})
        )
        check = fetcher.fetch(FetchRequest("https://www.example.org/apply"))
    assert check.outcome == "skipped" and check.reason == "host_policy:manual_only"
    assert check.redirect_chain == ["https://www.example.org/apply"]
    assert check.final_url == "https://foundation.smapply.io/prog/7"


def test_redirect_to_a_private_address_is_blocked(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        robots_ok(router)
        router.get("https://evil.example.org/robots.txt").mock(return_value=httpx.Response(200, text=""))
        router.get("https://www.example.org/r").mock(return_value=httpx.Response(301, headers={"location": "https://evil.example.org/x"}))
        check = fetcher.fetch(FetchRequest("https://www.example.org/r"))
        assert not any(c.request.url.host == "evil.example.org" and c.request.url.path == "/x" for c in router.calls)
    assert check.outcome == "blocked"


def test_robots_disallow_and_status_rules(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router, body="User-agent: NovusBot\nDisallow: /closed\n")
        check = fetcher.fetch(FetchRequest("https://www.example.org/closed/page"))
    assert check.outcome == "blocked" and check.reason == "robots"


@pytest.mark.parametrize(("status", "outcome"), [(503, "deferred"), (429, "deferred"), (403, "blocked"), (401, "blocked")])
def test_robots_failures(fetcher: Fetcher, status: int, outcome: str) -> None:
    with respx.mock(assert_all_called=False) as router:
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(status, headers={"retry-after": "120"}))
        page = router.get("https://www.example.org/p").mock(return_value=httpx.Response(200, text="x"))
        check = fetcher.fetch(FetchRequest("https://www.example.org/p"))
        assert page.call_count == 0
    assert check.outcome == outcome


def test_robots_404_allows_all(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        router.get("https://www.example.org/p").mock(return_value=httpx.Response(200, text="<p>Applications are due May 1, 2027.</p>"))
        assert fetcher.fetch(FetchRequest("https://www.example.org/p")).outcome == "ok"


def test_content_signal_search_no_makes_the_host_manual(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router, body="User-agent: *\nContent-Signal: search=no\nAllow: /\n")
        check = fetcher.fetch(FetchRequest("https://www.example.org/p"))
    assert check.outcome == "skipped" and check.reason == "content_signal_search"


def test_ai_input_no_is_carried_on_the_check(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router, body="User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n")
        router.get("https://www.example.org/p").mock(return_value=httpx.Response(200, text="<p>Applications are due May 1, 2027.</p>"))
        check = fetcher.fetch(FetchRequest("https://www.example.org/p"))
    assert check.outcome == "ok" and check.ai_input_allowed is False


def test_bot_challenge_is_blocked_and_never_retried(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        page = router.get("https://www.example.org/p").mock(
            return_value=httpx.Response(503, text="<html><title>Just a moment...</title><div id=cf-chl-widget></div></html>")
        )
        check = fetcher.fetch(FetchRequest("https://www.example.org/p"))
        assert page.call_count == 1
    assert check.outcome == "blocked" and check.reason == "bot_protection"


def test_5xx_retries_three_times_with_backoff_honoring_retry_after(fetcher: Fetcher, clock: FakeClock) -> None:
    fetcher.max_wait_seconds = float("inf")  # a laptop run may sleep; scheduled jobs may not
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        page = router.get("https://www.example.org/p").mock(
            side_effect=[httpx.Response(503, headers={"retry-after": "90"}), httpx.Response(502), httpx.Response(200, text="<p>ok</p>")]
        )
        check = fetcher.fetch(FetchRequest("https://www.example.org/p"))
        assert page.call_count == 3
    assert check.outcome == "ok"
    backoffs = [s for s in clock.slept if s >= 30]
    assert backoffs[:2] == [90, 60]


@pytest.mark.parametrize(("headers", "expected"), [({"retry-after": "3600"}, 3600.0), ({}, 30.0)])
def test_long_waits_are_deferred_to_the_worker_not_slept(
    fetcher: Fetcher, clock: FakeClock, headers: dict[str, str], expected: float
) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        page = router.get("https://www.example.org/p").mock(return_value=httpx.Response(503, headers=headers))
        check = fetcher.fetch(FetchRequest("https://www.example.org/p"))
    assert page.call_count == 1
    assert check.outcome == "deferred" and check.reason == "http_503" and check.retry_after == expected
    assert all(s <= fetcher.max_wait_seconds for s in clock.slept)


def test_huge_crawl_delay_defers_instead_of_sleeping(fetcher: Fetcher, clock: FakeClock) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router, body="User-agent: *\nCrawl-delay: 86400\n")
        page = router.get("https://www.example.org/p").mock(return_value=httpx.Response(200, text="<p>ok</p>"))
        first = fetcher.fetch(FetchRequest("https://www.example.org/p"))
        second = fetcher.fetch(FetchRequest("https://www.example.org/p"))
    # The first request follows the robots.txt request by more than the cap: deferred, not slept.
    assert first.outcome == "deferred" and first.reason == "host_spacing" and (first.retry_after or 0) > 86_000
    assert second.outcome == "deferred" and page.call_count == 0
    assert all(s <= fetcher.max_wait_seconds for s in clock.slept)


def test_persistent_failure_defers_and_five_failures_pause_the_host(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        router.get("https://www.example.org/p").mock(side_effect=httpx.ConnectError("boom"))
        outcomes = [fetcher.fetch(FetchRequest("https://www.example.org/p")).reason for _ in range(6)]
    assert outcomes[0] == "network_error"
    assert outcomes[-1] == "host_paused"


def test_404_is_a_failure_for_the_worker_to_count(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        router.get("https://www.example.org/gone").mock(return_value=httpx.Response(404))
        check = fetcher.fetch(FetchRequest("https://www.example.org/gone"))
    assert check.outcome == "failed" and check.reason == "http_404"


def test_decompression_bomb_aborts_at_the_cap(fetcher: Fetcher) -> None:
    bomb = gzip.compress(b"a" * (HTML_CAP_BYTES + 1024))
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        router.get("https://www.example.org/bomb").mock(
            return_value=httpx.Response(200, content=bomb, headers={"content-encoding": "gzip", "content-type": "text/html"})
        )
        check = fetcher.fetch(FetchRequest("https://www.example.org/bomb"))
    assert len(bomb) < HTML_CAP_BYTES
    assert check.outcome == "failed" and check.reason == "body_too_large"


def test_limiter_spaces_requests_to_one_host(fetcher: Fetcher, clock: FakeClock) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router, body="User-agent: *\nCrawl-delay: 4\n")
        router.get("https://www.example.org/a").mock(return_value=httpx.Response(200, text="<p>a</p>"))
        router.get("https://www.example.org/b").mock(return_value=httpx.Response(200, text="<p>b</p>"))
        fetcher.fetch(FetchRequest("https://www.example.org/a"))
        fetcher.fetch(FetchRequest("https://www.example.org/b"))
    assert clock.slept and all(s <= 4.0 for s in clock.slept)
    assert any(s == pytest.approx(4.0) for s in clock.slept)  # Crawl-delay above the 2 s floor


def test_too_many_redirects(fetcher: Fetcher) -> None:
    with respx.mock(assert_all_called=False) as router:
        robots_ok(router)
        for i in range(7):
            router.get(f"https://www.example.org/r{i}").mock(return_value=httpx.Response(302, headers={"location": f"/r{i + 1}"}))
        check = fetcher.fetch(FetchRequest("https://www.example.org/r0"))
    assert check.outcome == "failed" and check.reason == "too_many_redirects"
