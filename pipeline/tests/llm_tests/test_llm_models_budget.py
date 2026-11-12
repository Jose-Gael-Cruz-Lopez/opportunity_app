"""Model allowlist, prices, durable budget and breaker, and the metering record's contract."""

from __future__ import annotations

import logging
import re
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from novus_llm import ClosedBudget, Gateway, LlmCallRecord, LLMRequest, LlmSettings, SourcePolicy, StoreBudget, SubjectRef, UntrustedDoc
from novus_llm.prices import CEILING, cost_usd, rates
from novus_llm.providers import FakeProvider, ProviderError, ProviderResult
from novus_llm.settings import ALLOWED_MODELS, DEFAULT_GEMINI_MODEL, thinking_for

REPO = Path(__file__).resolve().parents[3]
URL = "https://www.example.org/fellowship"


class Tiny(BaseModel):
    answer: str


def request(route: str = "extract.page.v1") -> LLMRequest:
    return LLMRequest(
        route_id=route,
        subject=SubjectRef(type="snapshot", id="0193a1b2-0000-7000-8000-0000000000b1"),
        source=SourcePolicy(url=URL, host_policy="allowed", ai_input_allowed=True),
        documents=(UntrustedDoc(title=URL, text="Applications are due January 15, 2027."),),
    )


def ok() -> ProviderResult:
    return ProviderResult('{"answer": "x"}', "stop", input_tokens=1000, output_tokens=200, model_version="gemini-3.5-flash-lite", response_id="r1")


def env(**kw: str) -> dict[str, str]:
    return {"GEMINI_API_KEY": "test-key", **kw}


# --- allowlist --------------------------------------------------------------------------------


def test_default_matches_the_worker_and_is_allowlisted() -> None:
    ts = (REPO / "server" / "ai" / "config.ts").read_text()
    assert f'DEFAULT_MODEL = "{DEFAULT_GEMINI_MODEL}"' in ts
    block = ts[ts.index("export const MODELS") : ts.index("};", ts.index("export const MODELS"))]
    assert set(re.findall(r'^\s+"(gemini-[^"]+)":', block, re.M)) == set(ALLOWED_MODELS)


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        ("gemini-3.8-flash", "gemini-3.8-flash"),
        ("gemini-2.5-flash", DEFAULT_GEMINI_MODEL),  # deprecated, rerouted 2026-12-01
        ("gemini-4-pro-preview", DEFAULT_GEMINI_MODEL),
        ("", DEFAULT_GEMINI_MODEL),
    ],
)
def test_models_outside_the_allowlist_fall_back_and_are_logged(requested: str, expected: str, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="novus_llm.settings"):
        s = LlmSettings.from_env(env(GEMINI_MODEL=requested))
    assert s.model == expected
    assert ("not allowlisted" in caplog.text) == (requested not in ("", expected))


def test_a_disallowed_model_is_never_sent() -> None:
    provider = FakeProvider([ok()])
    gw = Gateway(LlmSettings.from_env(env(GEMINI_MODEL="gemini-2.5-pro")), provider, sleep=lambda s: None)
    res = gw.run(request(), Tiny)
    assert res.ok and provider.calls[0].model == DEFAULT_GEMINI_MODEL == res.model_requested


def test_thinking_levels_follow_each_models_table() -> None:
    assert thinking_for("gemini-3.8-flash", "minimal") == "low"
    assert thinking_for("gemini-3.1-flash-lite", "minimal") is None
    assert thinking_for("gemini-3.5-flash-lite", None) is None
    provider = FakeProvider([ProviderResult('{"answer": "x"}', "stop")])
    Gateway(LlmSettings.from_env(env()), provider).run(
        LLMRequest(route_id="docintel.read_span.v1", subject=SubjectRef(type="document_crop", id="c1"), instruction="x"), Tiny
    )
    assert provider.calls[0].thinking_level == "minimal"


# --- prices -----------------------------------------------------------------------------------


def test_prices_mirror_the_worker_with_dated_changes() -> None:
    assert rates("gemini-3.5-flash-lite", date(2026, 11, 11)) == (0.30, 2.50)
    assert rates("gemini-3.5-flash-lite-001", date(2026, 11, 11)) == (0.30, 2.50)  # served version suffix
    assert rates("gemini-3.8-flash", date(2026, 12, 31)) == (0.75, 3.75)
    assert rates("gemini-3.8-flash", date(2027, 1, 1)) == (1.50, 7.50)
    assert rates("gemini-2.5-flash") == CEILING
    assert cost_usd("gemini-3.1-flash-lite", 1_000_000, 0, on=date(2026, 11, 11)) == pytest.approx(0.25)


# --- durable budget and breaker -----------------------------------------------------------------


def test_production_without_a_durable_store_fails_closed() -> None:
    gw = Gateway.from_env(settings=LlmSettings.from_env(env(ENVIRONMENT="production")))
    assert isinstance(gw.budget, ClosedBudget)
    gw.provider = FakeProvider([ok()])
    res = gw.run(request(), Tiny)
    assert res.status == "budget_deferred" and gw.provider.calls == []  # type: ignore[union-attr]
    # An unknown environment value is treated as production.
    assert LlmSettings.from_env(env(ENVIRONMENT="prod")).environment == "production"


def test_spend_persists_across_runs_through_the_shared_store() -> None:
    store: dict[str, Any] = {}
    settings = LlmSettings.from_env(env(ENVIRONMENT="production", NOVUS_LLM_MONTHLY_CAP_USD="25"))
    first = Gateway.from_env(settings=settings, store=store)
    assert isinstance(first.budget, StoreBudget)
    first.provider = FakeProvider([ok()])
    spent = first.run(request(), Tiny).cost_usd
    # A new process (the next scheduled drain) sees the same month-to-date spend.
    second = Gateway.from_env(settings=settings, store=store)
    assert isinstance(second.budget, StoreBudget)
    assert second.budget.spent("extraction") == pytest.approx(spent) == second.budget.spent()


def test_store_budget_refuses_over_cap_and_settles_to_actual() -> None:
    store: dict[str, Any] = {}
    budget = StoreBudget(store, {"extraction": 1.0}, 1.5, clock=lambda: 1_794_000_000)
    r = budget.reserve("extraction", 0.8, "k")
    assert r is not None and budget.reserve("extraction", 0.3, "k2") is None
    budget.settle(r, 0.1)
    assert budget.spent("extraction") == pytest.approx(0.1)
    assert StoreBudget(store, {"extraction": 1.0}, 1.5, clock=lambda: 1_794_000_000).reserve("extraction", 0.85, "k3") is not None


def test_breaker_stays_open_across_runs() -> None:
    store: dict[str, Any] = {}
    settings = LlmSettings.from_env(env())
    for _ in range(5):
        gw = Gateway.from_env(settings=settings, store=store)
        gw.provider = FakeProvider([ProviderError("400", retryable=False, status=400)])
        gw.sleep = lambda s: None
        gw.run(request(), Tiny)
    fresh = Gateway.from_env(settings=settings, store=store)
    fresh.provider = FakeProvider([ok()])
    assert fresh.run(request(), Tiny).reason == "circuit_open"


# --- metering record --------------------------------------------------------------------------


def _zod_object(source: str, name: str) -> str:
    start = source.index(f"const {name} = z.object({{")
    return source[start : source.index("\n});", start)]


def test_record_mirrors_the_worker_schema() -> None:
    routes = REPO / "server" / "internal" / "routes.ts"
    if not routes.exists():
        pytest.skip("server source not present")
    block = _zod_object(routes.read_text(), "LlmCallRecordSchema")
    keys = set(re.findall(r"^\s{2}(\w+):", block, re.M))
    aliases = {f.alias for f in LlmCallRecord.model_fields.values()}
    assert aliases == keys
    status = re.search(r"status: z\.enum\(\[([^\]]+)\]\)", block)
    assert status is not None
    from novus_llm.record import RecordStatus

    import typing

    assert set(re.findall(r'"(\w+)"', status.group(1))) == set(typing.get_args(RecordStatus))
    for key in ("routeVersion", "modelRequested", "routeId"):
        assert re.search(rf"{key}: z\.string\(\)\.min\(1\)", block), key
    assert re.search(r"costMicros: z\.number\(\)\.int\(\)", block)


def test_gateway_records_are_valid_and_failures_are_logged(caplog: pytest.LogCaptureFixture) -> None:
    records: list[dict[str, Any]] = []
    gw = Gateway(LlmSettings.from_env(env()), FakeProvider([ok()]), recorder=records.append)
    gw.run(request(), Tiny)
    LlmCallRecord.model_validate(records[0])  # extra="forbid": nothing the Worker would drop

    def broken(_record: dict[str, Any]) -> None:
        raise ConnectionError("worker down")

    gw2 = Gateway(LlmSettings.from_env(env()), FakeProvider([ok()]), recorder=broken)
    with caplog.at_level(logging.WARNING, logger="novus_llm.gateway"):
        assert gw2.run(request(), Tiny).ok
    assert any(getattr(r, "error_class", None) == "ConnectionError" for r in caplog.records)
