"""The one LLM gateway for Python code (plan 8.9), with Gemini as the provider.

`run(request, output_model)`:
1. loads the route; a kill switch answers `killed` at no cost;
2. refuses, at no cost, student content, a data-class mismatch, a Snapshot whose host policy is not
   fetchable or whose robots Content-Signal says `ai-input=no`, and sensitive-looking variables;
3. degrades to `unavailable` when no API key is configured (callers proceed by hand);
4. reserves budget (over a cap: `budget_deferred`);
5. sends the route's system prompt plus the untrusted documents inside random boundaries;
6. checks the finish reason before content: a refusal goes to a person, a `max_tokens` stop
   retries once at double, transient errors retry with backoff, and five straight failures open
   a 10-minute breaker for the route;
7. validates the JSON with pydantic (`schema_invalid` otherwise), settles the actual cost and
   records one row per attempt through `recorder` with counts and ids, never text.

Only allowlisted models are sent (settings.ALLOWED_MODELS, mirroring server/ai/config.ts). The
budget and breaker live in a shared store in production (`from_env(store=...)`); production with
no durable store fails closed with `budget_deferred`, because a per-process cap resets on every
scheduled run and bounds nothing.

Domain validation (quotes on the page, parsed values) runs afterwards in the schema owner's code
(novus_pipeline.validators). The model never decides eligibility, dates or bands.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from .budget import BreakerBoard, Budget, ClosedBudget, InMemoryBudget, KeyValueStore, Reservation, StoreBudget
from .prices import cost_usd, reservation_usd, to_micros
from .privacy import block_reason, frame_document, new_boundary
from .providers.base import BinaryPart, GenerateCall, Provider, ProviderError, ProviderResult, TextPart
from .record import LlmCallRecord, RecordStatus
from .routes import RouteSpec, get_route, system_prompt
from .schema import response_schema_for
from .settings import DEFAULT_CLASS_CAPS_USD, LlmSettings, resolve_model, thinking_for
from .types import AttemptUsage, LLMRequest, LLMResult

M = TypeVar("M", bound=BaseModel)
# Receives the wire form of one LlmCallRecord (camelCase, the Worker's LlmCallRecordSchema).
Recorder = Callable[[dict[str, Any]], None]
log = logging.getLogger("novus_llm.gateway")

BREAKER_FAILURES = 5
BREAKER_SECONDS = 600.0
TRANSIENT_RETRIES = 2


@dataclass
class Gateway:
    settings: LlmSettings
    provider: Provider | None
    budget: Budget = field(default_factory=lambda: InMemoryBudget(DEFAULT_CLASS_CAPS_USD, 25.0))
    recorder: Recorder | None = None
    clock: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    breakers: BreakerBoard = field(default_factory=BreakerBoard)

    @classmethod
    def from_env(
        cls,
        *,
        recorder: Recorder | None = None,
        http_client: Any = None,
        store: KeyValueStore | None = None,
        settings: LlmSettings | None = None,
    ) -> Gateway:
        """`store` is a shared key-value store (a Modal Dict) holding the month's spend and the
        breakers. Without one, production refuses every call and other environments keep the
        caps in process memory."""
        settings = settings or LlmSettings.from_env()
        provider: Provider | None = None
        if settings.api_key:
            from .providers.gemini import GeminiProvider

            provider = GeminiProvider(settings.api_key, api_version=settings.api_version, http_client=http_client)
        caps = dict(DEFAULT_CLASS_CAPS_USD)
        budget: Budget
        if store is not None:
            budget = StoreBudget(store, caps, settings.monthly_cap_usd)
        elif settings.environment == "production":
            log.warning("no durable LLM budget store in production; refusing model calls", extra={"environment": settings.environment})
            budget = ClosedBudget()
        else:
            budget = InMemoryBudget(caps, settings.monthly_cap_usd)
        return cls(settings, provider, budget, recorder, breakers=BreakerBoard(store))

    @property
    def available(self) -> bool:
        return self.provider is not None

    # -----------------------------------------------------------------------------------------

    def _result(self, spec: RouteSpec, model: str, call_id: str, status: str, **kw: Any) -> LLMResult:
        return LLMResult(
            call_id=call_id,
            route_id=spec.route_id,
            route_version=spec.version,
            prompt_version=spec.prompt_version,
            model_requested=model,
            model_served=kw.pop("model_served", model),
            status=status,  # type: ignore[arg-type]
            **kw,
        )

    def _user_parts(self, req: LLMRequest) -> tuple[TextPart | BinaryPart, ...]:
        boundary = new_boundary()
        meta = "\n".join(f"{k}: {v}" for k, v in sorted(req.variables.items()))
        parts: list[TextPart | BinaryPart] = []
        header = "Run metadata (trusted):\n" + (meta or "(none)")
        if req.documents:
            header += f"\nDocuments follow, each between <<{boundary} ...>> and <<END {boundary}>> markers."
        parts.append(TextPart(header))
        parts.extend(TextPart(frame_document(d.title, d.text, boundary)) for d in req.documents)
        parts.extend(BinaryPart(img.mime_type, img.data) for img in req.images)
        return tuple(parts)

    def _record(
        self,
        spec: RouteSpec,
        model_requested: str,
        status: RecordStatus,
        attempt: AttemptUsage,
        response_id: str | None,
        reservation: Reservation,
    ) -> None:
        if self.recorder is None:
            return
        try:
            record = LlmCallRecord(
                route_id=spec.route_id,
                route_version=str(spec.version),
                model_requested=model_requested,
                model_served=attempt.model,
                status=status,
                input_tokens=attempt.input_tokens,
                output_tokens=attempt.output_tokens + attempt.thinking_tokens,
                cost_micros=to_micros(attempt.cost_usd),
                latency_ms=attempt.latency_ms,
                request_id=response_id[:120] if response_id else None,
                reservation_id=reservation.id,
            )
            self.recorder(record.wire())
        except Exception as exc:  # noqa: BLE001 - accounting must never break the call path
            # Unmetered spend must be visible: log the failure class (never the record's content).
            log.warning("llm call record not delivered", extra={"route_id": spec.route_id, "error_class": type(exc).__name__})

    def run(self, req: LLMRequest, output_model: type[M]) -> LLMResult:
        spec = get_route(req.route_id)
        model = resolve_model(spec.model, source=f"route:{spec.route_id}") if spec.model else self.settings.model
        call_id = uuid.uuid4().hex
        if self.settings.killed(spec.route_id):
            return self._result(spec, model, call_id, "killed")
        reason = block_reason(req, spec.data_class)
        if reason:
            return self._result(spec, model, call_id, "policy_blocked", reason=reason)
        if self.provider is None:
            return self._result(spec, model, call_id, "unavailable", reason="no_api_key")
        if self.breakers.open_until(spec.route_id) > self.clock():
            return self._result(spec, model, call_id, "error", reason="circuit_open")

        system = system_prompt(spec) + (f"\n\nTask:\n{req.instruction}" if req.instruction else "")
        parts = self._user_parts(req)
        schema = response_schema_for(output_model)
        input_chars = len(system) + sum(len(p.text) if isinstance(p, TextPart) else 1000 for p in parts)
        max_tokens = spec.max_output_tokens
        reservation = self.budget.reserve(spec.budget_class, reservation_usd(model, input_chars, max_tokens * 2), req.idempotency_key or call_id)
        if reservation is None:
            return self._result(spec, model, call_id, "budget_deferred", reason="over_cap")

        attempts: list[AttemptUsage] = []
        total = 0.0
        status, refusal, parsed, served, response_id, why = "error", None, None, model, None, None
        transient_left = TRANSIENT_RETRIES
        doubled = False
        try:
            while True:
                call = GenerateCall(model, system, parts, schema, max_tokens, thinking_for(model, spec.thinking))
                started = self.clock()
                try:
                    res: ProviderResult = self.provider.generate(call)
                except ProviderError as exc:
                    usage = AttemptUsage(attempt=len(attempts), model=model, finish="error")
                    attempts.append(usage)
                    self._record(spec, model, "timeout" if exc.status == 408 else "error", usage, None, reservation)
                    if exc.retryable and transient_left > 0:
                        transient_left -= 1
                        self.sleep(2.0 * (TRANSIENT_RETRIES - transient_left))
                        continue
                    self.breakers.record_failure(spec.route_id, self.clock(), BREAKER_FAILURES, BREAKER_SECONDS)
                    status, why = "error", f"provider_{exc.status or 'transport'}"
                    break
                served = res.model_version or model
                response_id = res.response_id
                attempt_cost = cost_usd(served, res.input_tokens, res.output_tokens, res.thinking_tokens)
                total += attempt_cost
                usage = AttemptUsage(
                    attempt=len(attempts),
                    model=served,
                    finish=res.finish,
                    input_tokens=res.input_tokens,
                    cached_tokens=res.cached_tokens,
                    output_tokens=res.output_tokens,
                    thinking_tokens=res.thinking_tokens,
                    cost_usd=attempt_cost,
                    latency_ms=int((self.clock() - started) * 1000),
                )
                attempts.append(usage)
                self.breakers.record_success(spec.route_id)
                if res.finish == "refused":
                    status, refusal = "refused", res.refusal_category
                    self._record(spec, model, "refused", usage, response_id, reservation)
                    break
                if res.finish == "max_tokens":
                    self._record(spec, model, "max_tokens", usage, response_id, reservation)
                    if not doubled:
                        doubled = True
                        max_tokens *= 2
                        continue
                    status = "max_tokens"
                    break
                try:
                    parsed = output_model.model_validate(json.loads(res.text or ""))
                    status = "ok"
                except (ValueError, ValidationError):
                    status, why = "schema_invalid", "output_failed_validation"
                self._record(spec, model, "ok" if status == "ok" else "schema_invalid", usage, response_id, reservation)
                break
        finally:
            self.budget.settle(reservation, total)
        return self._result(
            spec,
            model,
            call_id,
            status,
            model_served=served,
            reason=why,
            refusal_category=refusal,
            parsed=parsed,
            attempts=attempts,
            cost_usd=total,
            request_id=response_id,
        )
