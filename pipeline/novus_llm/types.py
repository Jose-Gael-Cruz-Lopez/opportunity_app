"""Request and result shapes of the LLM gateway (plan 8.9, adapted to the Gemini provider).

`LLMRequest` has no field that could hold a student profile, tracker item or SensitiveAnswers
value: its documents are public page text, its variables are run metadata (date, Source URL),
and the gateway refuses any variable whose name looks like a sensitive attribute.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DataClass = Literal["public_registry", "student_content"]
Status = Literal[
    "ok", "refused", "max_tokens", "schema_invalid", "budget_deferred", "killed", "policy_blocked",
    "unavailable", "error",
]  # fmt: skip


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SubjectRef(_Model):
    type: Literal["snapshot", "program_cycle", "document_crop", "eval_item"]
    id: str = Field(min_length=1, max_length=120)


class SourcePolicy(_Model):
    """Recorded at Snapshot capture: the host policy and the robots Content-Signal ai-input."""

    url: str
    host_policy: Literal["allowed", "api_only", "manual_only", "link_only", "never"]
    ai_input_allowed: bool


class UntrustedDoc(_Model):
    title: str = Field(max_length=500)  # the Source URL
    text: str


class ImagePart(_Model):
    mime_type: Literal["image/png", "image/jpeg"] = "image/png"
    data: bytes


class LLMRequest(_Model):
    route_id: str
    subject: SubjectRef
    data_class: DataClass = "public_registry"
    source: SourcePolicy | None = None
    documents: tuple[UntrustedDoc, ...] = ()
    images: tuple[ImagePart, ...] = ()
    variables: dict[str, str] = Field(default_factory=dict)
    # Trusted, code-supplied task text appended to the route's system prompt (DocIntel crops).
    instruction: str | None = None
    priority: int = Field(default=5, ge=0, le=9)
    idempotency_key: str = ""


class AttemptUsage(_Model):
    attempt: int
    model: str
    finish: str
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0


class LLMResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    call_id: str
    route_id: str
    route_version: int
    prompt_version: str
    model_requested: str
    model_served: str
    status: Status
    reason: str | None = None  # e.g. "no_api_key", "ai_input_opt_out", "host_policy"
    refusal_category: str | None = None
    parsed: Any = None  # the validated pydantic model when status == "ok"
    attempts: list[AttemptUsage] = Field(default_factory=list)
    cost_usd: float = 0.0
    request_id: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok" and self.parsed is not None

    @property
    def draft_unavailable_code(self) -> str | None:
        """The ReviewTask reason when no draft could be produced (plan 8.6)."""
        if self.ok:
            return None
        if self.status == "refused":
            category = re.sub(r"[^a-z_]", "_", (self.refusal_category or "other").lower())[:40]
            return f"refused:{category}"
        code = {"unavailable": "no_key"}.get(self.status, self.status)
        return f"draft_unavailable:{code}"
