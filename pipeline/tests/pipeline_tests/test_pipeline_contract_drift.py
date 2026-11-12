"""Pydantic mirrors must match the zod contracts' JSON Schema export (shared/contracts/json-schema).

Compares property names, required sets and enum values. Skips when the export is absent, so the
pipeline can be tested on its own; CI runs the export first.
"""

from __future__ import annotations

import json
import re
import typing
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from novus_pipeline import models
from novus_pipeline.taxonomy import OPPORTUNITY_TYPE_SLUGS

REPO = Path(__file__).resolve().parents[3]
SCHEMAS = REPO / "shared" / "contracts" / "json-schema"

pytestmark = pytest.mark.skipif(not SCHEMAS.is_dir(), reason="JSON Schema export not present")

MIRRORS: dict[str, type[BaseModel]] = {
    "SnapshotIngest": models.SnapshotIngest,
    "ExtractionIngest": models.ExtractionIngest,
    "ExtractionPageV1": models.ExtractionPageV1,
    "EligibilityRow": models.EligibilityRow,
    "Heartbeat": models.Heartbeat,
    "Job": models.Job,
    "JobLeaseRequest": models.JobLeaseRequest,
    "JobLeaseResponse": models.JobLeaseResponse,
    "CreateReviewTaskInput": models.CreateReviewTaskInput,
}


# Fields the pipeline sends that the zod contract must add (owned outside the pipeline). Listed
# here so the gap is explicit; once the export has a field, the test fails until it is removed.
PENDING_CONTRACT_FIELDS: dict[str, set[str]] = {"ExtractionIngest": {"validation"}}


def load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((SCHEMAS / f"{name}.json").read_text())
    return data


def wire_props(model: type[BaseModel]) -> tuple[set[str], set[str]]:
    props, required = set(), set()
    for name, field in model.model_fields.items():
        alias = field.alias or name
        props.add(alias)
        if field.is_required():
            required.add(alias)
    return props, required


@pytest.mark.parametrize("name", sorted(MIRRORS))
def test_property_names_match(name: str) -> None:
    schema = load(name)
    props, required = wire_props(MIRRORS[name])
    pending = PENDING_CONTRACT_FIELDS.get(name, set())
    assert not pending & set(schema["properties"]), f"{name}: contract now has {pending}; drop it from PENDING_CONTRACT_FIELDS"
    assert props - pending == set(schema["properties"]), name
    # zod `.default()` fields are optional on input; the mirror may require fewer, never more.
    assert required - pending <= set(schema.get("required", [])) | {"payload"}, name


def literal_values(tp: Any) -> set[str]:
    return set(typing.get_args(tp))


def enum_at(schema: dict[str, Any], *path: str) -> set[str]:
    node: Any = schema
    for key in path:
        node = node[key]
    if "anyOf" in node:
        node = next(n for n in node["anyOf"] if "enum" in n)
    return set(node["enum"])


def test_enum_values_match() -> None:
    assert literal_values(models.SourceKind) == enum_at(load("SnapshotIngest"), "properties", "sourceKind")
    assert literal_values(models.PipelineJobKind) == enum_at(load("JobLeaseRequest"), "properties", "kinds", "items")
    task = load("CreateReviewTaskInput")
    assert literal_values(models.ReviewTaskKind) == enum_at(task, "properties", "kind")
    assert literal_values(models.EvidenceEntity) == enum_at(task, "properties", "subject", "properties", "type")
    assert models.REVIEW_REASON_CODES == enum_at(task, "properties", "reasonCodes", "items")
    row = load("EligibilityRow")
    assert literal_values(models.EligibilityDimension) == enum_at(row, "properties", "dimension")
    page = load("ExtractionPageV1")
    assert literal_values(models.PageKind) == enum_at(page, "properties", "page_kind")
    deadline = page["properties"]["deadlines"]["items"]["properties"]
    assert literal_values(models.DeadlineKind) == set(deadline["kind"]["enum"])
    req = page["properties"]["requirements"]["items"]["properties"]
    assert literal_values(models.RequirementKind) == set(req["kind"]["enum"])


def test_opportunity_type_slugs_match_taxonomy() -> None:
    ts = (REPO / "shared" / "taxonomy" / "opportunity-types.ts").read_text()
    assert tuple(re.findall(r'slug: "([a-z_]+)"', ts)) == OPPORTUNITY_TYPE_SLUGS


def test_extraction_schema_has_no_unions_or_optionals() -> None:
    from novus_llm.schema import schema_cost

    assert schema_cost(models.ExtractionPageV1.model_json_schema()) == (0, 0)
    assert schema_cost(models.ExtractionDeltaV1.model_json_schema()) == (0, 0)
