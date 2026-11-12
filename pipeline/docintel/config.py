"""Versioned DocIntel configuration.

Every number that changes a reading lives here, so `config_hash()` changes
whenever behaviour changes and OCRRun rows stay reproducible.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field

# Bump when canonicalization or triage rules change: stored offsets point into
# text produced by a specific version.
TEXT_LAYER_CONFIG_VERSION = "tl-2026.11.1"
NORMALIZATION_VERSION = "norm-1"


@dataclass(frozen=True)
class Limits:
    max_pdf_bytes: int = 32 * 1024 * 1024
    max_pages: int = 200
    max_page_side_pt: float = 14_400.0  # keeps 0.5-pt boxes inside int16
    max_image_megapixels: float = 40.0
    max_ocr_pages: int = 10


@dataclass(frozen=True)
class TriageRules:
    min_printable_chars: int = 50
    max_garbage_ratio: float = 0.15


@dataclass(frozen=True)
class RenderRules:
    """Raster rules from plan 5.4.3: cap at 40 MP and a 4,000 px long edge."""

    display_dpi: float = 110.0
    ocr_dpi: float = 300.0
    max_pixels: float = 40_000_000.0
    max_long_edge_px: float = 4_000.0
    blind_crop_min_short_edge_px: int = 200
    blind_crop_upscale_below_px: int = 20


@dataclass(frozen=True)
class MatchRules:
    line_min_iou: float = 0.3


@dataclass(frozen=True)
class CostRates:
    """Modal list rates used to estimate REQ-067's cost field (versioned here)."""

    usd_per_core_second: float = 0.0000131
    usd_per_gib_second: float = 0.00000222
    cores: float = 2.0
    gib: float = 2.0


@dataclass(frozen=True)
class DocIntelConfig:
    version: str = TEXT_LAYER_CONFIG_VERSION
    normalization: str = NORMALIZATION_VERSION
    limits: Limits = field(default_factory=Limits)
    triage: TriageRules = field(default_factory=TriageRules)
    render: RenderRules = field(default_factory=RenderRules)
    match: MatchRules = field(default_factory=MatchRules)
    cost: CostRates = field(default_factory=CostRates)

    def config_hash(self) -> str:
        """Stable SHA-256 over the whole configuration (sorted JSON)."""
        blob = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()


DEFAULT_CONFIG = DocIntelConfig()
