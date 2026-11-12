"""Gemini provider over the google-genai SDK (the founders' chosen provider).

- The key comes from GEMINI_API_KEY via LlmSettings and is passed to the SDK only.
- Output is JSON constrained by `response_json_schema`; the gateway re-validates it with pydantic.
- Safety settings block only high-probability harm, because program pages legitimately discuss
  harassment policies or lab safety; a block is reported as a refusal and goes to a person.
- The SDK's own retries are off (one attempt); the gateway owns retries and the circuit breaker.
- Nothing here logs content. Errors carry status codes only.

Data use: Google may use content sent on unpaid (free-tier) Gemini API projects to improve its
products, so production must use a billing-enabled project. Only public program text is sent.
"""

from __future__ import annotations

from typing import Any

from .base import BinaryPart, GenerateCall, ProviderError, ProviderResult, TextPart

_REFUSAL_FINISH = {
    "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "LANGUAGE",
}  # fmt: skip
_HARM_CATEGORIES = (
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
)


def _enum_name(value: Any) -> str:
    if value is None:
        return ""
    return str(getattr(value, "name", value)).split(".")[-1].upper()


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str, *, api_version: str | None = None, http_client: Any = None, timeout_ms: int = 120_000) -> None:
        from google import genai  # imported lazily: tests and keyless runs never need it
        from google.genai import types

        self._types = types
        options: dict[str, Any] = {
            "timeout": timeout_ms,
            "retry_options": types.HttpRetryOptions(attempts=1),
        }
        if api_version:
            options["api_version"] = api_version
        if http_client is not None:
            options["httpx_client"] = http_client
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(**options))

    def _parts(self, call: GenerateCall) -> list[Any]:
        t = self._types
        out: list[Any] = []
        for p in call.parts:
            if isinstance(p, TextPart):
                out.append(t.Part(text=p.text))
            elif isinstance(p, BinaryPart):
                out.append(t.Part.from_bytes(data=p.data, mime_type=p.mime_type))
        return out

    def generate(self, call: GenerateCall) -> ProviderResult:
        from google.genai import errors

        t = self._types
        config: dict[str, Any] = {
            "system_instruction": call.system,
            "response_mime_type": "application/json",
            "response_json_schema": call.response_schema,
            "max_output_tokens": call.max_output_tokens,
            "safety_settings": [
                t.SafetySetting(category=c, threshold="BLOCK_ONLY_HIGH") for c in _HARM_CATEGORIES
            ],
        }
        if call.thinking_level is not None:
            # Gemini 3 models take a thinking level; the 2.5-era token budget is not sent.
            config["thinking_config"] = t.ThinkingConfig(thinking_level=call.thinking_level)
        try:
            resp = self._client.models.generate_content(
                model=call.model,
                contents=[t.Content(role="user", parts=self._parts(call))],
                config=t.GenerateContentConfig(**config),
            )
        except errors.APIError as exc:
            code = int(getattr(exc, "code", 0) or 0)
            raise ProviderError(f"gemini api error {code}", retryable=code in (408, 429) or code >= 500, status=code) from None
        except Exception as exc:  # transport errors from httpx and friends
            raise ProviderError(f"gemini transport error {type(exc).__name__}", retryable=True) from None

        usage = resp.usage_metadata
        counts = {
            "input_tokens": int(getattr(usage, "prompt_token_count", 0) or 0),
            "cached_tokens": int(getattr(usage, "cached_content_token_count", 0) or 0),
            "output_tokens": int(getattr(usage, "candidates_token_count", 0) or 0),
            "thinking_tokens": int(getattr(usage, "thoughts_token_count", 0) or 0),
        }
        meta = {"model_version": resp.model_version, "response_id": resp.response_id}
        block = _enum_name(getattr(resp.prompt_feedback, "block_reason", None)) if resp.prompt_feedback else ""
        if block and block != "BLOCKED_REASON_UNSPECIFIED":
            return ProviderResult(None, "refused", refusal_category=block.lower(), **counts, **meta)
        if not resp.candidates:
            return ProviderResult(None, "other", **counts, **meta)
        finish = _enum_name(resp.candidates[0].finish_reason)
        text = resp.text
        if finish in _REFUSAL_FINISH:
            return ProviderResult(None, "refused", refusal_category=finish.lower(), **counts, **meta)
        if finish == "MAX_TOKENS":
            return ProviderResult(text, "max_tokens", **counts, **meta)
        if finish in ("STOP", ""):
            return ProviderResult(text, "stop", **counts, **meta)
        return ProviderResult(text, "other", **counts, **meta)
