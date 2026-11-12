"""The LLM metering record posted to `/internal/v1/llm-calls`, one per attempt.

Mirror of the Worker's `LlmCallRecordSchema` (server/internal/routes.ts); the drift test in
tests/llm_tests compares the two, so a renamed or retyped field fails CI instead of being
dropped with a silent 400. Counts and ids only: no prompt, page or output text.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

RecordStatus = Literal["ok", "schema_invalid", "refused", "max_tokens", "timeout", "error", "degraded"]


class LlmCallRecord(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True)

    route_id: str = Field(min_length=1, max_length=60)
    route_version: str = Field(min_length=1, max_length=20)
    provider: str = Field(default="gemini", max_length=40)
    model_requested: str = Field(min_length=1, max_length=80)
    model_served: str | None = Field(default=None, max_length=80)
    status: RecordStatus
    input_tokens: int = Field(default=0, ge=0)
    # Thinking tokens bill as output, and the ledger has one output column, so they are included.
    output_tokens: int = Field(default=0, ge=0)
    cost_micros: int = Field(default=0, ge=0)
    latency_ms: int | None = Field(default=None, ge=0)
    request_id: str | None = Field(default=None, max_length=120)
    reservation_id: str | None = Field(default=None, max_length=80)

    def wire(self) -> dict[str, object]:
        return self.model_dump(mode="json", by_alias=True)
