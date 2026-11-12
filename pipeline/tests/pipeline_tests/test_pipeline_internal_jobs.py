from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import respx

from novus_pipeline.fetcher import Fetcher
from novus_pipeline.internal_client import InternalApi, InternalApiError, canonical_string
from novus_pipeline.jobs import PipelineDeps, drain
from novus_pipeline.limiter import HostLimiter
from novus_pipeline.netguard import AddressGuard

BASE = "https://internal.novus.example"
SECRET = "test-secret-not-real"
CYCLE = "0193a1b2-0000-7000-8000-0000000000c1"
SOURCE = "0193a1b2-0000-7000-8000-0000000000a1"
SNAP = "0193a1b2-0000-7000-8000-0000000000b1"
NOW = datetime(2026, 11, 11, 9, tzinfo=UTC)


def api(**kw: Any) -> InternalApi:
    nonces = iter(f"{i:032x}" for i in range(1000))
    return InternalApi(BASE, "fetch-key-1", SECRET, clock=lambda: 1_794_000_000, nonce=lambda: next(nonces), sleep=lambda s: None, **kw)


def test_signature_matches_an_independent_computation() -> None:
    with respx.mock(assert_all_called=False) as router:
        route = router.post(f"{BASE}/internal/v1/heartbeats").mock(return_value=httpx.Response(204))
        api().post("/internal/v1/heartbeats", {"worker": "w", "at": "2026-11-11T09:00:00Z", "version": "0", "leasedJobs": 0}, idempotency_key="k1")
    req = route.calls[0].request
    body_sha = hashlib.sha256(req.content).hexdigest()
    expected = hmac.new(
        SECRET.encode(),
        canonical_string("POST", "/internal/v1/heartbeats", "1794000000", "0" * 32, body_sha, "fetch-key-1").encode(),
        hashlib.sha256,
    ).hexdigest()
    assert req.headers["x-novus-signature"] == expected
    assert req.headers["x-novus-key-id"] == "fetch-key-1"
    assert req.headers["x-novus-content-sha256"] == body_sha
    assert req.headers["idempotency-key"] == "k1"
    assert SECRET not in json.dumps(dict(req.headers))


def test_retries_reuse_idempotency_key_with_fresh_nonce() -> None:
    with respx.mock(assert_all_called=False) as router:
        route = router.post(f"{BASE}/internal/v1/jobs/lease").mock(
            side_effect=[httpx.Response(503), httpx.Response(200, json={"jobs": []})]
        )
        assert api().lease_jobs(["fetch"], "modal-1") == []
    first, second = (c.request for c in route.calls)
    assert first.headers["idempotency-key"] == second.headers["idempotency-key"]
    assert first.headers["x-novus-nonce"] != second.headers["x-novus-nonce"]
    assert json.loads(first.content) == {"kinds": ["fetch"], "max": 5, "leaseSeconds": 600, "owner": "modal-1"}


def test_client_errors_are_not_retried_and_carry_only_the_problem_code() -> None:
    with respx.mock(assert_all_called=False) as router:
        route = router.post(f"{BASE}/internal/v1/snapshots").mock(
            return_value=httpx.Response(422, json={"code": "host_policy_refused", "detail": "page text here"})
        )
        with pytest.raises(InternalApiError) as exc:
            api().post("/internal/v1/snapshots", {})
        assert route.call_count == 1
    assert exc.value.code == "host_policy_refused" and "page text" not in str(exc.value)


# --- drain end to end -----------------------------------------------------------------------------


def job(kind: str, payload: dict[str, Any], jid: str = "0193a1b2-0000-7000-8000-0000000000f1") -> dict[str, Any]:
    return {
        "id": jid, "kind": kind, "payload": payload, "idempotencyKey": f"{kind}:{jid}", "concurrencyKey": "host:www.example.org",
        "status": "leased", "priority": 5, "attempts": 0, "maxAttempts": 5, "runAfter": "2026-11-11T09:00:00Z",
        "leaseOwner": "modal-1", "leaseExpiresAt": "2026-11-11T09:10:00Z", "lastError": None, "finishedAt": None,
    }  # fmt: skip


def deps(client: httpx.Client) -> PipelineDeps:
    fetcher = Fetcher(
        client,
        guard=AddressGuard(resolver=lambda h, p: ["93.184.215.14"]),
        limiter=HostLimiter(sleep=lambda s: None),
        sleep=lambda s: None,
    )
    return PipelineDeps(api(client=client), fetcher, now=lambda: NOW)


def mock_worker(router: respx.MockRouter, jobs: list[dict[str, Any]]) -> dict[str, respx.Route]:
    return {
        "catchup": router.post(f"{BASE}/internal/v1/tick/catch-up").mock(return_value=httpx.Response(204)),
        "lease": router.post(f"{BASE}/internal/v1/jobs/lease").mock(side_effect=[httpx.Response(200, json={"jobs": jobs}), httpx.Response(200, json={"jobs": []})]),
        "snapshot": router.post(f"{BASE}/internal/v1/snapshots").mock(return_value=httpx.Response(200, json={"snapshotId": SNAP, "changeClass": None, "stored": True})),
        "task": router.post(f"{BASE}/internal/v1/review-tasks").mock(return_value=httpx.Response(200, json={})),
        "complete": router.post(url__regex=rf"{BASE}/internal/v1/jobs/.+/complete").mock(return_value=httpx.Response(204)),
        "fail": router.post(url__regex=rf"{BASE}/internal/v1/jobs/.+/fail").mock(return_value=httpx.Response(204)),
        "heartbeat": router.post(f"{BASE}/internal/v1/heartbeats").mock(return_value=httpx.Response(204)),
    }


def test_fetch_job_uploads_snapshot_classifies_and_requests_a_task(sample_html: bytes) -> None:
    moved = sample_html.replace(b"Friday, January 15, 2027", b"Monday, November 23, 2026")
    base_sha = hashlib.sha256(sample_html).hexdigest()
    payload = {
        "sourceId": SOURCE, "url": "https://www.example.org/fellowship", "kind": "official_page", "programCycleId": CYCLE,
        "baseline": {"snapshotId": SNAP, "rawSha256": base_sha},
        "verifiedQuotes": [{"family": "deadline", "quote": "Applications are due Friday, January 15, 2027 at 5:00 PM Eastern Time.", "deadlineDate": "2027-01-15"}],
        "cycleStatus": "open", "daysToDeadline": 12,
    }  # fmt: skip
    with respx.mock(assert_all_called=False) as router:
        routes = mock_worker(router, [job("fetch", payload)])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *\nAllow: /\n"))
        router.get("https://www.example.org/fellowship").mock(return_value=httpx.Response(200, content=moved, headers={"content-type": "text/html"}))
        router.get(f"{BASE}/internal/v1/snapshots/raw/{base_sha}").mock(return_value=httpx.Response(200, content=sample_html))
        with httpx.Client() as client:
            stats = drain(deps(client), ["fetch"], "modal-1", rounds=2)
    assert (stats.leased, stats.completed, stats.failed) == (1, 1, 0)
    snap = json.loads(routes["snapshot"].calls[0].request.content)
    assert base64.b64decode(snap["rawBase64"]) == moved and snap["sourceId"] == SOURCE and snap["aiInputAllowed"] is True
    task = json.loads(routes["task"].calls[0].request.content)
    assert task["kind"] == "cycle_update" and task["reasonCodes"] == ["urgent_recheck"]
    result = json.loads(routes["complete"].calls[0].request.content)["result"]
    assert result["changeClass"] == "key" and result["triage"]["urgent"] is True
    assert result["nextCheckAt"] is not None and "body" not in result["check"]
    assert routes["heartbeat"].called


def test_deferred_fetch_fails_with_defer_and_unknown_kinds_are_dead() -> None:
    payload = {"sourceId": SOURCE, "url": "https://www.example.org/p"}
    with respx.mock(assert_all_called=False) as router:
        routes = mock_worker(router, [job("fetch", payload), job("nsf_sync", {}, "0193a1b2-0000-7000-8000-0000000000f2")])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(503))
        with httpx.Client() as client:
            stats = drain(deps(client), ["fetch", "nsf_sync"], "modal-1")
    bodies = [json.loads(c.request.content) for c in routes["fail"].calls]
    assert stats.failed == 2
    assert bodies[0]["disposition"] == "defer" and bodies[0]["errorClass"] == "deferred:robots_unreachable"
    assert bodies[1] == {"owner": "modal-1", "errorClass": "no_handler", "disposition": "dead"}


def test_shadow_mode_opens_no_key_change_task(sample_html: bytes) -> None:
    more = sample_html.replace(b"</main>", b"<p>Finalists are notified by March 30, 2027.</p></main>")
    base_sha = hashlib.sha256(sample_html).hexdigest()
    payload = {"sourceId": SOURCE, "url": "https://www.example.org/f", "programCycleId": CYCLE, "shadow": True, "baseline": {"snapshotId": SNAP, "rawSha256": base_sha}}
    with respx.mock(assert_all_called=False) as router:
        routes = mock_worker(router, [job("fetch", payload)])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        router.get("https://www.example.org/f").mock(return_value=httpx.Response(200, content=more, headers={"content-type": "text/html"}))
        router.get(f"{BASE}/internal/v1/snapshots/raw/{base_sha}").mock(return_value=httpx.Response(200, content=sample_html))
        with httpx.Client() as client:
            drain(deps(client), ["fetch"], "modal-1")
    result = json.loads(routes["complete"].calls[0].request.content)["result"]
    assert result["changeClass"] == "key" and result["shadowed"] is True and not routes["task"].called
