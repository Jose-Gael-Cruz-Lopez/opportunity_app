"""Route registry: one entry per immutable route version (plan 8.9).

The model comes from GEMINI_MODEL at run time; a route may pin one for evaluation reproducibility.
Prompts are files in `prompts/`, versioned with the route. `data_class` is the only class a route
accepts; every pipeline route is `public_registry`.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from importlib import resources

from pydantic import BaseModel

from .settings import ThinkingLevel


@dataclass(frozen=True)
class RouteSpec:
    route_id: str
    version: int
    prompt_file: str
    prompt_version: str
    budget_class: str
    data_class: str
    max_output_tokens: int
    # Requested thinking level, mapped per model by settings.thinking_for; None sends no config.
    thinking: ThinkingLevel | None = None
    model: str | None = None  # None means GEMINI_MODEL; a pinned id must be allowlisted


ROUTES: dict[str, RouteSpec] = {
    "extract.page.v1": RouteSpec("extract.page.v1", 1, "extract.page.v1.md", "extract.page/v1", "extraction", "public_registry", 16_000),
    "extract.delta.v1": RouteSpec("extract.delta.v1", 1, "extract.delta.v1.md", "extract.delta/v1", "extraction", "public_registry", 8_000),
    "docintel.read_span.v1": RouteSpec(
        "docintel.read_span.v1", 1, "docintel.read_span.v1.md", "read_span/v1", "extraction", "public_registry", 1_024, thinking="minimal"
    ),
}


@cache
def system_prompt(spec: RouteSpec) -> str:
    text = resources.files("novus_llm").joinpath("prompts", spec.prompt_file).read_text(encoding="utf-8")
    if "{opportunity_types}" in text:
        from novus_pipeline.taxonomy import OPPORTUNITY_TYPE_SLUGS

        text = text.replace("{opportunity_types}", ", ".join(OPPORTUNITY_TYPE_SLUGS))
    return text


def get_route(route_id: str) -> RouteSpec:
    try:
        return ROUTES[route_id]
    except KeyError:
        raise KeyError(f"unknown route {route_id}") from None


def output_model_for(route_id: str) -> type[BaseModel]:
    from novus_pipeline.models import ExtractionDeltaV1, ExtractionPageV1

    return {"extract.page.v1": ExtractionPageV1, "extract.delta.v1": ExtractionDeltaV1}[route_id]
