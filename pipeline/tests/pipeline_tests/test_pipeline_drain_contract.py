"""Drain behaviour against the Worker's contract: key scopes, the fetch result round trip, the
extraction validation section, deferral hints and the drain's time budget."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from novus_llm import Gateway, LlmSettings
from novus_llm.providers import FakeProvider, ProviderResult
from novus_pipeline.fetcher import Fetcher
from novus_pipeline.internal_client import InternalApi
from novus_pipeline.jobs import PipelineDeps, drain, next_fetch_facts
from novus_pipeline.limiter import HostLimiter
from novus_pipeline.netguard import AddressGuard

REPO = Path(__file__).resolve().parents[3]
BASE = "https://internal.novus.example"
SECRET = "test-secret-not-real-0123456789abcdef"
CYCLE = "0193a1b2-0000-7000-8000-0000000000c1"
SOURCE = "0193a1b2-0000-7000-8000-0000000000a1"
SNAP = "0193a1b2-0000-7000-8000-0000000000b1"
SNAP2 = "0193a1b2-0000-7000-8000-0000000000b2"
NOW = datetime(2026, 11, 11, 9, tzinfo=UTC)
PAGE = "https://www.example.org/fellowship"


def client_api(key_id: str, http: httpx.Client) -> InternalApi:
    nonces = iter(f"{i:032x}" for i in range(10_000))
    return InternalApi(BASE, key_id, SECRET, client=http, clock=lambda: 1_794_000_000, nonce=lambda: next(nonces), sleep=lambda s: None)


def job(kind: str, payload: dict[str, Any], jid: str = "0193a1b2-0000-7000-8000-0000000000f1") -> dict[str, Any]:
    return {
        "id": jid, "kind": kind, "payload": payload, "idempotencyKey": f"{kind}:{jid}", "concurrencyKey": None,
        "status": "leased", "priority": 5, "attempts": 0, "maxAttempts": 5, "runAfter": "2026-11-11T09:00:00Z",
        "leaseOwner": "modal-1", "leaseExpiresAt": "2026-11-11T09:10:00Z", "lastError": None, "finishedAt": None,
    }  # fmt: skip


def fetcher(http: httpx.Client) -> Fetcher:
    return Fetcher(http, guard=AddressGuard(resolver=lambda h, p: ["93.184.215.14"]), limiter=HostLimiter(sleep=lambda s: None), sleep=lambda s: None)


# --- which key may call which route (server/internal/keys.ts) -------------------------------------

ROUTE_BY_PATH: list[tuple[str, str, str]] = [
    ("POST", r"/internal/v1/jobs/lease", "leaseJobs"),
    ("POST", r"/internal/v1/jobs/[^/]+/complete", "completeJob"),
    ("POST", r"/internal/v1/jobs/[^/]+/fail", "failJob"),
    ("POST", r"/internal/v1/tick/catch-up", "tickCatchUp"),
    ("POST", r"/internal/v1/heartbeats", "heartbeat"),
    ("POST", r"/internal/v1/review-tasks", "createReviewTask"),
    ("POST", r"/internal/v1/extractions", "ingestExtraction"),
    ("POST", r"/internal/v1/llm-calls", "llmCalls"),
    ("POST", r"/internal/v1/snapshots", "ingestSnapshot"),
    ("PUT", r"/internal/v1/snapshots/raw/[0-9a-f]{64}", "putSnapshotRaw"),
    ("GET", r"/internal/v1/snapshots/raw/[0-9a-f]{64}", "getSnapshotRaw"),
    ("GET", r"/internal/v1/snapshots/[^/]+", "getSnapshot"),
]


def key_scopes() -> dict[str, set[str]]:
    src = (REPO / "server" / "internal" / "keys.ts").read_text()
    job_routes = re.findall(r'"(\w+)"', re.search(r"const JOB_ROUTES = \[([^\]]*)\]", src).group(1))  # type: ignore[union-attr]
    body = src[src.index("export const KEY_SCOPES") :]
    scopes: dict[str, set[str]] = {}
    for family, routes in re.findall(r"^\s{2}(\w+): \{\s*routes: \[([^\]]*)\]", body, re.M):
        names = set(re.findall(r'"(\w+)"', routes))
        if "...JOB_ROUTES" in routes:
            names |= set(job_routes)
        scopes[family] = names
    return scopes


def route_of(request: httpx.Request) -> str:
    for method, pattern, route in ROUTE_BY_PATH:
        if request.method == method and re.fullmatch(pattern, request.url.path):
            return route
    raise AssertionError(f"unmapped internal call {request.method} {request.url.path}")


def calls_by_family(router: respx.MockRouter) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for call in router.calls:
        if call.request.url.host != "internal.novus.example":
            continue
        family = re.split(r"[.:]", call.request.headers["x-novus-key-id"], maxsplit=1)[0]
        out.setdefault(family, set()).add(route_of(call.request))
    return out


def worker(router: respx.MockRouter, jobs: list[dict[str, Any]], snapshot_ids: list[str] | None = None) -> dict[str, respx.Route]:
    snaps = [httpx.Response(201, json={"snapshotId": s, "changeClass": None, "stored": True}) for s in (snapshot_ids or [SNAP])]
    return {
        "catchup": router.post(f"{BASE}/internal/v1/tick/catch-up").mock(return_value=httpx.Response(200, json={"ran": False})),
        "lease": router.post(f"{BASE}/internal/v1/jobs/lease").mock(
            side_effect=[httpx.Response(200, json={"jobs": jobs}), *[httpx.Response(200, json={"jobs": []})] * 5]
        ),
        "snapshot": router.post(f"{BASE}/internal/v1/snapshots").mock(side_effect=snaps),
        "task": router.post(f"{BASE}/internal/v1/review-tasks").mock(return_value=httpx.Response(201, json={})),
        "extraction": router.post(f"{BASE}/internal/v1/extractions").mock(return_value=httpx.Response(201, json={"reviewTaskId": "t", "created": True})),
        "llm_calls": router.post(f"{BASE}/internal/v1/llm-calls").mock(return_value=httpx.Response(201, json={"id": "c"})),
        "complete": router.post(url__regex=rf"{BASE}/internal/v1/jobs/.+/complete").mock(return_value=httpx.Response(200, json={"status": "done"})),
        "fail": router.post(url__regex=rf"{BASE}/internal/v1/jobs/.+/fail").mock(return_value=httpx.Response(200, json={"status": "deferred"})),
        "heartbeat": router.post(f"{BASE}/internal/v1/heartbeats").mock(return_value=httpx.Response(200, json={"ok": True})),
    }


def test_fetch_drain_calls_only_routes_its_keys_may_call(sample_html: bytes) -> None:
    payload = {"sourceId": SOURCE, "url": PAGE, "programCycleId": CYCLE}
    with respx.mock(assert_all_called=False) as router:
        routes = worker(router, [job("fetch", payload)])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        router.get(PAGE).mock(return_value=httpx.Response(200, content=sample_html, headers={"content-type": "text/html"}))
        with httpx.Client() as http:
            deps = PipelineDeps(client_api("fetch.test", http), fetcher(http), now=lambda: NOW, clock_api=client_api("clock.test", http))
            drain(deps, ["fetch"], "modal-1")
        used = calls_by_family(router)
    assert routes["catchup"].called
    scopes = key_scopes()
    for family, called in used.items():
        assert called <= scopes[family], (family, called - scopes[family])
    assert used["clock"] == {"tickCatchUp"} and "tickCatchUp" not in used["fetch"]


def test_without_a_clock_key_the_watchdog_is_skipped() -> None:
    with respx.mock(assert_all_called=False) as router:
        routes = worker(router, [])
        with httpx.Client() as http:
            stats = drain(PipelineDeps(client_api("fetch.test", http), fetcher(http), now=lambda: NOW), ["fetch"], "modal-1")
    assert not routes["catchup"].called and stats.errors == []


# --- fetch result round trip: the second fetch of a changed page opens a task -----------------------


def test_second_fetch_of_a_changed_page_opens_a_task_and_sends_validators(sample_html: bytes) -> None:
    moved = sample_html.replace(b"Friday, January 15, 2027", b"Monday, November 23, 2026")
    payload: dict[str, Any] = {
        "sourceId": SOURCE, "url": PAGE, "programCycleId": CYCLE, "cycleStatus": "open", "daysToDeadline": 12,
        "verifiedQuotes": [{"family": "deadline", "quote": "Applications are due Friday, January 15, 2027 at 5:00 PM Eastern Time.", "deadlineDate": "2027-01-15"}],
    }  # fmt: skip
    base_sha = hashlib.sha256(sample_html).hexdigest()

    with respx.mock(assert_all_called=False) as router:
        first = worker(router, [job("fetch", payload)])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        router.get(PAGE).mock(return_value=httpx.Response(200, content=sample_html, headers={"content-type": "text/html", "etag": '"v1"'}))
        with httpx.Client() as http:
            drain(PipelineDeps(client_api("fetch.test", http), fetcher(http), now=lambda: NOW), ["fetch"], "modal-1")
    result1 = json.loads(first["complete"].calls[0].request.content)["result"]
    assert result1["outcome"] == "ok" and result1["changeClass"] == "new" and not first["task"].called
    facts = next_fetch_facts(result1)
    assert facts["baseline"]["snapshotId"] == SNAP and facts["baseline"]["rawSha256"] == base_sha and facts["etag"] == '"v1"'

    # What the Worker sends next: the same Source facts plus the stored baseline and validators.
    second_payload = {**payload, **facts}
    with respx.mock(assert_all_called=False) as router:
        second = worker(router, [job("fetch", second_payload, "0193a1b2-0000-7000-8000-0000000000f2")], [SNAP2])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        page = router.get(PAGE).mock(return_value=httpx.Response(200, content=moved, headers={"content-type": "text/html", "etag": '"v2"'}))
        router.get(f"{BASE}/internal/v1/snapshots/raw/{base_sha}").mock(return_value=httpx.Response(200, content=sample_html))
        with httpx.Client() as http:
            drain(PipelineDeps(client_api("fetch.test", http), fetcher(http), now=lambda: NOW), ["fetch"], "modal-1")
    assert page.calls[0].request.headers["if-none-match"] == '"v1"'
    result2 = json.loads(second["complete"].calls[0].request.content)["result"]
    assert result2["changeClass"] == "key" and result2["triage"]["urgent"] is True
    task = json.loads(second["task"].calls[0].request.content)
    assert task["kind"] == "cycle_update" and task["subject"] == {"type": "program_cycle", "id": CYCLE}
    assert next_fetch_facts(result2)["baseline"]["snapshotId"] == SNAP2


def test_deferral_tells_the_worker_when_to_retry() -> None:
    payload = {"sourceId": SOURCE, "url": "https://www.example.org/p"}
    with respx.mock(assert_all_called=False) as router:
        routes = worker(router, [job("fetch", payload)])
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        router.get("https://www.example.org/p").mock(return_value=httpx.Response(503, headers={"retry-after": "3600"}))
        with httpx.Client() as http:
            drain(PipelineDeps(client_api("fetch.test", http), fetcher(http), now=lambda: NOW), ["fetch"], "modal-1")
    body = json.loads(routes["fail"].calls[0].request.content)
    assert body["disposition"] == "defer" and body["errorClass"] == "deferred:http_503:retry_after=3600s"


def test_time_budget_hands_back_unstarted_jobs() -> None:
    ticks = iter([0.0, 0.0, 0.0, 500.0, 500.0, 500.0])
    payloads = [job("fetch", {"sourceId": SOURCE, "url": f"https://www.example.org/{i}"}, f"0193a1b2-0000-7000-8000-00000000000{i}") for i in range(2)]
    with respx.mock(assert_all_called=False) as router:
        routes = worker(router, payloads)
        router.get("https://www.example.org/robots.txt").mock(return_value=httpx.Response(404))
        router.get(url__regex=r"https://www\.example\.org/\d").mock(return_value=httpx.Response(404))
        with httpx.Client() as http:
            deps = PipelineDeps(client_api("fetch.test", http), fetcher(http), now=lambda: NOW, monotonic=lambda: next(ticks, 500.0))
            stats = drain(deps, ["fetch"], "modal-1", rounds=3, time_budget_seconds=480)
    assert (stats.completed, stats.released) == (1, 1)
    released = json.loads(routes["fail"].calls[0].request.content)
    assert released["errorClass"] == "drain_time_budget" and released["disposition"] == "defer"
    assert routes["lease"].call_count == 1 and routes["heartbeat"].called


# --- extraction: a fabricated quote reaches the Worker marked as blocked ---------------------------------


def test_fabricated_quote_reaches_the_worker_blocked_with_its_code(fixtures_dir: Path, sample_html: bytes) -> None:
    proposal = json.loads((fixtures_dir / "sample_proposal.json").read_text())
    proposal["stipend"] = {"value": "$9,000", "quote": "Fellows receive a stipend of $9,000.", "status": "found", "basis": "stated"}
    raw_sha = hashlib.sha256(sample_html).hexdigest()
    gateway = Gateway(
        LlmSettings(api_key="test-key", model="gemini-3.5-flash-lite", api_version=None, monthly_cap_usd=25.0, kill=frozenset()),
        FakeProvider([ProviderResult(json.dumps(proposal), "stop", input_tokens=100, output_tokens=50, response_id="sample-r1")]),
        sleep=lambda s: None,
    )
    meta = {
        "id": SNAP, "finalUrl": PAGE, "rawSha256": raw_sha, "contentType": "text/html", "fetchedAt": "2026-11-11T09:00:00Z",
        "hostPolicy": "allowed", "aiInputAllowed": True, "cycleKey": "summer-2027", "officialDomains": [], "volatilePatterns": [],
    }  # fmt: skip
    with respx.mock(assert_all_called=False) as router:
        routes = worker(router, [job("llm", {"routeId": "extract.page.v1", "snapshotId": SNAP, "programCycleId": CYCLE})])
        router.get(f"{BASE}/internal/v1/snapshots/{SNAP}").mock(return_value=httpx.Response(200, json=meta))
        router.get(f"{BASE}/internal/v1/snapshots/raw/{raw_sha}").mock(return_value=httpx.Response(200, content=sample_html))
        with httpx.Client() as http:
            api = client_api("llm.test", http)
            gateway.recorder = api.record_llm_call
            drain(PipelineDeps(api, fetcher(http), gateway=gateway, now=lambda: NOW), ["llm"], "modal-1")
        used = calls_by_family(router)
    body = json.loads(routes["extraction"].calls[0].request.content)
    validation = body["validation"]
    assert validation["blocked"] is True and "stipend" in validation["blockedPaths"]
    stipend = next(f for f in validation["fields"] if f["path"] == "stipend")
    assert stipend["blocked"] is True and stipend["outcome"] == "blocked" and stipend["code"] == "QUOTE_NOT_ON_PAGE"
    assert stipend["parsedValue"] is None  # a blocked field is never presented as a value
    program = next(f for f in validation["fields"] if f["path"] == "program_name")
    assert program["blocked"] is False and isinstance(program["start"], int) and program["end"] > program["start"]
    assert "Fellows receive" not in json.dumps(validation)  # codes and offsets, no page text
    # The metering record reached the Worker in the shape LlmCallRecordSchema accepts.
    record = json.loads(routes["llm_calls"].calls[0].request.content)
    assert record["routeVersion"] == "1" and record["modelRequested"] == "gemini-3.5-flash-lite" and isinstance(record["costMicros"], int)
    assert used["llm"] <= key_scopes()["llm"]


@pytest.mark.parametrize("family", ["fetch", "llm"])
def test_drain_keys_cannot_call_the_watchdog(family: str) -> None:
    assert "tickCatchUp" not in key_scopes()[family]
