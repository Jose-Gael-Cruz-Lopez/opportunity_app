"""The field catalogue and lookup tables, read from data/catalogue.json.

The file is generated from shared/ by infra/eligibility/snapshots.ts and checked for freshness by
infra/eligibility/eligibility.test.ts, so this port never re-types a TypeScript table by hand.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"

CIP_CODE_PATTERN = re.compile(r"^\d{2}(\.\d{2}(\d{2})?)?$")
ISO_DATE_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
ISO_MONTH_PATTERN = re.compile(r"^(\d{4})-(\d{2})$")
TERM_KEY_PATTERN = re.compile(r"^(winter|spring|summer|fall)-(\d{4})$")


@dataclass(frozen=True)
class FieldDef:
    key: str
    label: str
    value_type: str
    dimension: str
    source: str
    sensitive: bool
    values: tuple[str, ...]
    unknown_values: tuple[str, ...]


@dataclass(frozen=True)
class Catalogue:
    engine_version: str
    dimensions: tuple[str, ...]
    launch_dimensions: tuple[str, ...]
    operators: tuple[str, ...]
    fields: dict[str, FieldDef]
    class_years: tuple[str, ...]
    class_year_index: dict[str, int | None]
    gpa_band_bounds: dict[str, dict[str, float] | None]
    major_families: tuple[str, ...]
    major_family_cip_series: dict[str, tuple[str, ...]]
    reasons: dict[str, str]
    self_check: dict[str, str]
    dimension_labels: dict[str, str]
    max_text: int

    def field(self, key: str) -> FieldDef | None:
        return self.fields.get(key)

    def is_sensitive_field(self, key: str) -> bool:
        f = self.fields.get(key)
        return f.sensitive if f else False


def _load(path: Path) -> Catalogue:
    raw: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    fields = {
        key: FieldDef(
            key=key,
            label=d["label"],
            value_type=d["valueType"],
            dimension=d["dimension"],
            source=d["source"],
            sensitive=bool(d["sensitive"]),
            values=tuple(d.get("values", ())),
            unknown_values=tuple(d.get("unknownValues", ())),
        )
        for key, d in raw["fields"].items()
    }
    return Catalogue(
        engine_version=raw["engineVersion"],
        dimensions=tuple(raw["dimensions"]),
        launch_dimensions=tuple(raw["launchDimensions"]),
        operators=tuple(raw["operators"]),
        fields=fields,
        class_years=tuple(raw["classYears"]),
        class_year_index=dict(raw["classYearIndex"]),
        gpa_band_bounds=dict(raw["gpaBandBounds"]),
        major_families=tuple(raw["majorFamilies"]),
        major_family_cip_series={k: tuple(v) for k, v in raw["majorFamilyCipSeries"].items()},
        reasons=dict(raw["reasons"]),
        self_check=dict(raw["selfCheck"]),
        dimension_labels=dict(raw["dimensionLabels"]),
        max_text=int(raw["maxText"]),
    )


CATALOGUE = _load(DATA_DIR / "catalogue.json")
ENGINE_VERSION = CATALOGUE.engine_version


def major_family_for_cip(cip: str) -> str | None:
    if not CIP_CODE_PATTERN.match(cip):
        return None
    series = cip[:2]
    for family in CATALOGUE.major_families:
        if series in CATALOGUE.major_family_cip_series.get(family, ()):
            return family
    return None


def cip_matches_prefix(cip: str, prefix: str) -> bool:
    return cip == prefix or cip.startswith(f"{prefix}." if len(prefix) == 2 else prefix)
