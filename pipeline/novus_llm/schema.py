"""JSON Schema for model output: inlined, flat, and within structured-output limits.

Every route schema has no unions and no optional properties (plan 8.5); `schema_cost` counts both
so CI fails a schema that drifts. `response_schema_for` inlines `$ref`s and drops keywords the
Gemini schema subset does not need (titles, defaults); local pydantic validation stays strict.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

_DROP = frozenset({"title", "default", "examples", "$schema", "additionalProperties"})


def _inline(node: Any, defs: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            return _inline(defs[node["$ref"].rsplit("/", 1)[-1]], defs)
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in _DROP or k == "$defs":
                continue
            if k == "const":
                out["enum"] = [v]
                continue
            out[k] = _inline(v, defs)
        return out
    if isinstance(node, list):
        return [_inline(v, defs) for v in node]
    return node


def response_schema_for(model: type[BaseModel]) -> dict[str, Any]:
    raw = model.model_json_schema()
    result: dict[str, Any] = _inline(raw, raw.get("$defs", {}))
    return result


def schema_cost(node: dict[str, Any], defs: dict[str, Any] | None = None) -> tuple[int, int]:
    """(union-typed parameters, optional parameters), expanding local refs (plan 8.5)."""
    defs = defs if defs is not None else node.get("$defs", {})
    if "$ref" in node:
        node = defs[node["$ref"].rsplit("/", 1)[-1]]
    unions = int("anyOf" in node or "oneOf" in node or isinstance(node.get("type"), list))
    optional = 0
    required = set(node.get("required", []))
    for key, child in node.get("properties", {}).items():
        optional += key not in required
        u, o = schema_cost(child, defs)
        unions += u
        optional += o
    children = [node.get("items"), *node.get("anyOf", []), *node.get("oneOf", [])]
    for child in children:
        if isinstance(child, dict):
            u, o = schema_cost(child, defs)
            unions += u
            optional += o
    return unions, optional
