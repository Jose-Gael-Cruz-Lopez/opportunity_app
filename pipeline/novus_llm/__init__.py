"""novus_llm: the provider-agnostic LLM gateway for Python code (Gemini provider).

Public surface:
- `Gateway` (`run(request, output_model) -> LLMResult`), `Gateway.from_env()`
- `LLMRequest`, `LLMResult`, `SubjectRef`, `SourcePolicy`, `UntrustedDoc`, `ImagePart`
- `LlmSettings` (model allowlist mirrored from server/ai/config.ts), `GatewayImageLlm`
- budgets: `StoreBudget` (shared store, production), `InMemoryBudget` (tests, laptop),
  `ClosedBudget` (fail closed); `LlmCallRecord` (the Worker's metering record)

No student data ever passes through here; see `privacy.block_reason`.
"""

from .budget import BreakerBoard, ClosedBudget, InMemoryBudget, Reservation, StoreBudget
from .gateway import Gateway
from .image import GatewayImageLlm
from .record import LlmCallRecord
from .settings import ALLOWED_MODELS, DEFAULT_GEMINI_MODEL, LlmSettings
from .types import ImagePart, LLMRequest, LLMResult, SourcePolicy, SubjectRef, UntrustedDoc

__all__ = [
    "ALLOWED_MODELS",
    "DEFAULT_GEMINI_MODEL",
    "BreakerBoard",
    "ClosedBudget",
    "Gateway",
    "GatewayImageLlm",
    "ImagePart",
    "InMemoryBudget",
    "LLMRequest",
    "LLMResult",
    "LlmCallRecord",
    "LlmSettings",
    "Reservation",
    "SourcePolicy",
    "StoreBudget",
    "SubjectRef",
    "UntrustedDoc",
]
