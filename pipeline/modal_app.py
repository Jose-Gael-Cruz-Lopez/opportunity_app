"""Modal functions for the pipeline (plan 4.2). `modal` is imported lazily, so tests and laptop
runs never need it; `modal deploy pipeline/modal_app.py` builds the app from `build_app()`.

Functions
- `normalize_html_restricted`: parses untrusted HTML with no network, no secrets, no Modal
  access, one input per container, 1 GiB and 30 seconds (plan 4.5, "Parsing untrusted bytes").
- `drain_fetch`: every 10 minutes, calls the Worker's catch-up watchdog with the clock key,
  then leases `fetch` jobs and runs them with the fetch key.
- `drain_llm`: leases `llm` jobs and drafts extractions through novus_llm (Gemini). Holds the
  llm ingest key and GEMINI_API_KEY; never sees student data. One container at a time, because
  its month-to-date spend and breakers live in a shared Modal Dict.

Shared state (Modal Dicts): host spacing, robots.txt cache, host health (five straight failures
pause a host for six hours) and the LLM budget and breakers. Each scheduled run is a new
process, so none of these may live in process memory.

Secrets (created in Modal, never in the repository): `novus-fetch-key` and `novus-llm-key` with
NOVUS_INTERNAL_BASE_URL, NOVUS_INTERNAL_KEY_ID, NOVUS_INTERNAL_KEY_SECRET (and optional
Cloudflare Access service-token values); `novus-clock-key` with NOVUS_INTERNAL_CLOCK_KEY_ID and
NOVUS_INTERNAL_CLOCK_KEY_SECRET (a `clock.*` key: tickCatchUp only); `novus-gemini` with
GEMINI_API_KEY, GEMINI_MODEL and ENVIRONMENT. Function inputs and outputs carry ids and public
page text only, because Modal retains them.
"""

from __future__ import annotations

import dataclasses
import importlib.util
from collections.abc import Sequence
from typing import Any

APP_NAME = "novus-pipeline"
LIMITER_DICT = "novus-host-limiter"
ROBOTS_DICT = "novus-robots-cache"
HEALTH_DICT = "novus-host-health"
LLM_DICT = "novus-llm-budget"
DRAIN_TIMEOUT_SECONDS = 540
# Stop starting jobs well before Modal's timeout, so leased jobs are handed back, not stranded.
DRAIN_TIME_BUDGET_SECONDS = DRAIN_TIMEOUT_SECONDS - 60
PIP_PACKAGES = (
    "httpx==0.28.1",
    "httpcore==1.0.9",
    "pydantic>=2.14,<3",
    "lxml>=6.1,<7",
    "python-dateutil>=2.9",
    "google-genai>=3.1,<4",
)


def doc_to_dict(doc: Any) -> dict[str, Any]:
    return dataclasses.asdict(doc)


def doc_from_dict(data: dict[str, Any]) -> Any:
    from novus_pipeline.normalize import NormalizedDoc

    data = dict(data)
    data["suspect_ranges"] = tuple(tuple(r) for r in data.get("suspect_ranges", ()))
    data["key_windows"] = tuple(data.get("key_windows", ()))
    data["jsonld"] = tuple(data.get("jsonld", ()))
    return NormalizedDoc(**data)


def normalize_locally(raw: bytes, content_type: str | None, volatile: Sequence[str]) -> dict[str, Any]:
    """The body of the restricted function, importable and testable without Modal."""
    from novus_pipeline.normalize import normalize_html

    return doc_to_dict(normalize_html(raw, content_type, volatile_patterns=list(volatile)))


def run_drain(
    kinds: Sequence[str],
    *,
    normalizer: Any = None,
    limiter_store: Any = None,
    robots_store: Any = None,
    health_store: Any = None,
    llm_store: Any = None,
    time_budget_seconds: float | None = DRAIN_TIME_BUDGET_SECONDS,
) -> dict[str, Any]:
    """Shared drain body for the scheduled functions (and for a laptop break-glass drain)."""
    import time

    from novus_pipeline.config import PipelineConfig
    from novus_pipeline.fetcher import Fetcher
    from novus_pipeline.internal_client import InternalApi
    from novus_pipeline.jobs import PipelineDeps, drain, local_normalizer
    from novus_pipeline.limiter import HostHealth, HostLimiter
    from novus_pipeline.netguard import build_client
    from novus_pipeline.robots import RobotsCache

    cfg = PipelineConfig.from_env()
    api = InternalApi.from_config(cfg)
    clock_api = InternalApi.clock_from_config(cfg)
    gateway = None
    if "llm" in kinds:
        from novus_llm import Gateway

        # Production without llm_store answers budget_deferred for every call (fail closed).
        gateway = Gateway.from_env(recorder=api.record_llm_call, store=llm_store)
    with build_client(cfg.user_agent, cfg.from_address) as client:
        fetcher = Fetcher(
            client,
            limiter=HostLimiter(limiter_store, clock=time.time),
            health=HostHealth(health_store, clock=time.time),
        )
        if robots_store is not None:
            fetcher.robots = RobotsCache(fetcher._load_robots, robots_store)  # noqa: SLF001 - wiring only
        deps = PipelineDeps(api, fetcher, normalizer=normalizer or local_normalizer, gateway=gateway, clock_api=clock_api)
        stats = drain(deps, kinds, cfg.worker_name, max_jobs=10, time_budget_seconds=time_budget_seconds)
    return {"leased": stats.leased, "completed": stats.completed, "failed": stats.failed, "released": stats.released, "errors": stats.errors}


def build_app() -> Any:
    import modal

    image = (
        modal.Image.debian_slim(python_version="3.12")
        .pip_install(*PIP_PACKAGES)
        .add_local_python_source("novus_pipeline", "novus_llm")
    )
    app = modal.App(APP_NAME)
    fetch_key = modal.Secret.from_name("novus-fetch-key")
    clock_key = modal.Secret.from_name("novus-clock-key")
    llm_key = modal.Secret.from_name("novus-llm-key")
    gemini = modal.Secret.from_name("novus-gemini")

    @app.function(
        image=image,
        block_network=True,
        restrict_modal_access=True,
        single_use_containers=True,
        memory=1024,
        timeout=30,
    )
    def normalize_html_restricted(raw: bytes, content_type: str | None, volatile: list[str]) -> dict[str, Any]:
        return normalize_locally(raw, content_type, volatile)

    def remote_normalizer(raw: bytes, content_type: str | None, volatile: Sequence[str]) -> Any:
        from novus_pipeline.normalize import NormalizeError

        try:
            return doc_from_dict(normalize_html_restricted.remote(raw, content_type, list(volatile)))
        except Exception as exc:  # the restricted function's failure is a parse failure here
            raise NormalizeError(type(exc).__name__) from None

    @app.function(image=image, secrets=[fetch_key, clock_key], schedule=modal.Period(minutes=10), timeout=DRAIN_TIMEOUT_SECONDS)
    def drain_fetch() -> dict[str, Any]:
        return run_drain(
            ["fetch"],
            normalizer=remote_normalizer,
            limiter_store=modal.Dict.from_name(LIMITER_DICT, create_if_missing=True),
            robots_store=modal.Dict.from_name(ROBOTS_DICT, create_if_missing=True),
            health_store=modal.Dict.from_name(HEALTH_DICT, create_if_missing=True),
        )

    # max_containers=1: the shared budget's read-modify-write must not interleave.
    @app.function(
        image=image, secrets=[llm_key, gemini], schedule=modal.Period(minutes=10), timeout=DRAIN_TIMEOUT_SECONDS, max_containers=1
    )
    def drain_llm() -> dict[str, Any]:
        return run_drain(["llm"], normalizer=remote_normalizer, llm_store=modal.Dict.from_name(LLM_DICT, create_if_missing=True))

    return app


app = build_app() if importlib.util.find_spec("modal") is not None else None
