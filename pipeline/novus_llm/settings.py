"""Gateway settings from the environment. The key is never logged, printed or defaulted."""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

log = logging.getLogger("novus_llm.settings")

ThinkingLevel = Literal["minimal", "low", "medium", "high"]
THINKING_ORDER: tuple[ThinkingLevel, ...] = ("minimal", "low", "medium", "high")

# Mirror of server/ai/config.ts MODELS (checked against the Gemini docs on 2026-11-11). The same
# ids on both sides, so one GEMINI_MODEL value means the same thing in the Worker and in Modal.
# Deprecated 2.5 ids (rerouted 2026-12-01), preview ids and Gemini 4 are deliberately absent:
# a mistyped or risky GEMINI_MODEL falls back to the default instead of being sent.
MODEL_THINKING_LEVELS: Mapping[str, tuple[ThinkingLevel, ...]] = {
    "gemini-3.5-flash-lite": ("minimal", "low", "medium", "high"),
    "gemini-3.1-flash-lite": (),  # not in the thinking table: never send a thinking config
    "gemini-3.8-flash": ("low", "medium", "high"),  # "minimal" is an error on 3.8 Flash
    "gemini-3.6-flash": ("low", "medium", "high"),
}
ALLOWED_MODELS: frozenset[str] = frozenset(MODEL_THINKING_LEVELS)

# Same default as server/ai/config.ts DEFAULT_MODEL; the founders set GEMINI_MODEL per environment.
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
# Plan 8.8 / 8.9 ledger: production total and class sub-caps in USD per month (founder decision).
DEFAULT_CLASS_CAPS_USD: dict[str, float] = {
    "extraction": 19.0,
    "report_delta": 2.5,
    "hint_extraction": 1.0,
    "curator_reserve": 2.5,
}

Environment = Literal["local", "staging", "production"]


def is_allowlisted(model: str) -> bool:
    return model in ALLOWED_MODELS


def resolve_model(requested: str | None, *, source: str = "GEMINI_MODEL") -> str:
    """The model to send: the requested id when allowlisted, otherwise the default (logged)."""
    if not requested:
        return DEFAULT_GEMINI_MODEL
    if is_allowlisted(requested):
        return requested
    # The id is configuration, not a secret, so it is safe to log; it is clipped in case of junk.
    log.warning("model not allowlisted; using default", extra={"source": source, "requested": requested[:80], "model": DEFAULT_GEMINI_MODEL})
    return DEFAULT_GEMINI_MODEL


def thinking_for(model: str, requested: ThinkingLevel | None) -> ThinkingLevel | None:
    """The thinking level to send, or None to send no thinking config (server/ai thinkingFor).

    A level the model does not accept moves up to the nearest accepted one."""
    if requested is None:
        return None
    levels = MODEL_THINKING_LEVELS.get(model, ())
    if not levels:
        return None
    if requested in levels:
        return requested
    for level in THINKING_ORDER[THINKING_ORDER.index(requested) :]:
        if level in levels:
            return level
    return levels[-1]


def _environment(e: Mapping[str, str]) -> Environment:
    raw = (e.get("NOVUS_ENVIRONMENT") or e.get("ENVIRONMENT") or "local").strip().lower()
    return raw if raw in ("local", "staging", "production") else "production"  # type: ignore[return-value]  # unknown fails closed


@dataclass(frozen=True)
class LlmSettings:
    api_key: str | None
    model: str
    api_version: str | None
    monthly_cap_usd: float
    kill: frozenset[str]  # "all" or route ids, mirroring the Worker's llm.all / llm.<route> flags
    environment: Environment = "local"

    def __post_init__(self) -> None:
        # Every construction path (env or tests) ends on an allowlisted model.
        object.__setattr__(self, "model", resolve_model(self.model))

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> LlmSettings:
        e = os.environ if env is None else env
        kill = frozenset(k.strip() for k in e.get("NOVUS_LLM_KILL", "").split(",") if k.strip())
        return cls(
            api_key=e.get("GEMINI_API_KEY") or None,
            model=e.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL,
            api_version=e.get("NOVUS_GEMINI_API_VERSION") or None,
            monthly_cap_usd=float(e.get("NOVUS_LLM_MONTHLY_CAP_USD", "25")),
            kill=kill,
            environment=_environment(e),
        )

    def killed(self, route_id: str) -> bool:
        return "all" in self.kill or route_id in self.kill

    def __repr__(self) -> str:  # never show the key
        return (
            f"LlmSettings(model={self.model!r}, api_key={'set' if self.api_key else 'unset'}, "
            f"cap={self.monthly_cap_usd}, environment={self.environment!r})"
        )
