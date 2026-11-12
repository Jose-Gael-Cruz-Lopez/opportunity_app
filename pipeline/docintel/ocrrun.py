"""OCRRun rows: one per engine run, never holding document text (REQ-067)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from .config import CostRates
from .contracts import OcrRunRow, OcrRunStatus


def estimate_cost_micro_usd(duration_ms: int, rates: CostRates) -> int:
    """Wall time x (cores x core rate + GiB x memory rate), in micro-dollars."""
    seconds = duration_ms / 1000.0
    usd = seconds * (rates.cores * rates.usd_per_core_second + rates.gib * rates.usd_per_gib_second)
    return round(usd * 1_000_000)


def new_run_id() -> str:
    return str(uuid.uuid7())


def build_ocr_run(
    *,
    stage: str,
    engine: str,
    engine_version: str,
    config_hash: str,
    input_hash: str | None,
    pages: int,
    duration_ms: int,
    status: OcrRunStatus,
    rates: CostRates,
    error_code: str | None = None,
    mean_confidence: float | None = None,
    model_id: str | None = None,
    prompt_version: str | None = None,
    snapshot_id: str | None = None,
    document_id: str | None = None,
    now: datetime | None = None,
) -> OcrRunRow:
    return OcrRunRow(
        id=new_run_id(),
        snapshot_id=snapshot_id,
        document_id=document_id,
        stage=stage,
        engine=engine,
        engine_version=engine_version,
        model_id=model_id,
        prompt_version=prompt_version,
        config_hash=config_hash,
        input_hash=input_hash,
        pages=pages,
        duration_ms=duration_ms,
        mean_confidence=mean_confidence,
        cost_micro_usd=estimate_cost_micro_usd(duration_ms, rates),
        status=status,
        error_code=error_code,
        created_at=(now or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
    )
