"""DocIntel entry points.

- `parse_pdf`   official PDFs: text layer, quality, triage and an OCRRun row.
- `locate`      boxes for a span of a TextLayer page (evidence display).
- `read_public_pages`  two-engine OCR of public document pages, critical-token
                agreement, optional blind LLM adjudication.
- `check_student_letter` (in letters.py) student sandbox body.

Every entry point that parses bytes calls `require_isolation` first; tests
pass a fake environment and network probe.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

import pypdfium2

from .adjudicate import BLIND_READ_PROMPT_VERSION, AdjudicationStats, BlindReader, adjudicate_page
from .boxes import merge_line_boxes, unpack_char_boxes
from .config import DEFAULT_CONFIG, DocIntelConfig
from .contracts import BBox, CriticalTokenReport, OcrRunRow, PageQuality, PdfBox, TextLayer, TextLayerPage
from .engines.base import EngineResult, OCREngine
from .errors import DocIntelError, LimitExceeded
from .isolation import DocumentClass, default_network_probe, require_isolation
from .ocrrun import build_ocr_run
from .quality import document_triage
from .raster import PageRasterizer, PdfiumRasterizer, RasterImage
from .reconcile import ReconciledPage, check_page
from .textlayer import SecondReader, extract_text_layer, pdfplumber_reader

log = logging.getLogger("docintel.api")

TEXT_LAYER_STAGE = "text_layer"
OCR_STAGE = "ocr"
ADJUDICATION_STAGE = "blind_read"


@dataclass
class ParseResult:
    status: str  # "ok" | "no_text_layer" | "parse_failed" | "limit_exceeded"
    text_layer: TextLayer | None
    ocr_run: OcrRunRow
    quality: list[PageQuality] = field(default_factory=list)
    page_images: list[RasterImage] = field(default_factory=list)
    error_code: str | None = None


def _engine_version() -> str:
    return f"pypdfium2 {pypdfium2.version.PYPDFIUM_INFO}; pdfium {pypdfium2.version.PDFIUM_INFO.build}"


def parse_pdf(
    pdf: bytes,
    *,
    render_pages: bool = False,
    config: DocIntelConfig = DEFAULT_CONFIG,
    second_reader: SecondReader | None = pdfplumber_reader,
    rasterizer: PageRasterizer | None = None,
    snapshot_id: str | None = None,
    env: Mapping[str, str] | None = None,
    network_probe: Callable[[], bool] = default_network_probe,
) -> ParseResult:
    """Parse an official PDF in the restricted runtime (plan 5.4).

    Never raises for bad input: a parse failure or limit returns a result with
    `text_layer=None` and the error code, plus an OCRRun row, so the caller
    can route the Snapshot to manual curation.
    """
    require_isolation(DocumentClass.PUBLIC, env=env, network_probe=network_probe)
    started = time.perf_counter()
    sha = hashlib.sha256(pdf).hexdigest()
    try:
        pages = extract_text_layer(pdf, config, second_reader=second_reader)
        images: list[RasterImage] = []
        if render_pages:
            r = rasterizer or PdfiumRasterizer(config.render, max_page_side_pt=config.limits.max_page_side_pt)
            images = r.render(pdf, target_dpi=config.render.display_dpi, max_pages=config.limits.max_pages)
    except DocIntelError as exc:
        duration = round((time.perf_counter() - started) * 1000)
        run = build_ocr_run(
            stage=TEXT_LAYER_STAGE, engine="pypdfium2", engine_version=_engine_version(),
            config_hash=config.config_hash(), input_hash=sha, pages=0, duration_ms=duration,
            status="failed", error_code=str(exc), rates=config.cost, snapshot_id=snapshot_id,
        )
        log.info("parse_pdf_failed", extra={"code": exc.code})
        status = "limit_exceeded" if exc.code == "limit_exceeded" else "parse_failed"
        return ParseResult(status=status, text_layer=None, ocr_run=run, error_code=str(exc))

    triage = document_triage([p.quality.status for p in pages])
    duration = round((time.perf_counter() - started) * 1000)
    run = build_ocr_run(
        stage=TEXT_LAYER_STAGE, engine="pypdfium2", engine_version=_engine_version(),
        config_hash=config.config_hash(), input_hash=sha, pages=len(pages), duration_ms=duration,
        status="ok", rates=config.cost, snapshot_id=snapshot_id,
    )
    layer = TextLayer(
        sha256=sha,
        triage=triage,
        language="en",
        pages=[p.layer_page for p in pages],
        qr=[],
        ocr_run_ids=[run.id],
    )
    return ParseResult(
        status="ok" if triage == "born_digital" else "no_text_layer",
        text_layer=layer,
        ocr_run=run,
        quality=[p.quality for p in pages],
        page_images=images,
    )


def locate(layer: TextLayer, page: int, start: int, end: int) -> list[PdfBox] | list[BBox]:
    """Boxes for canonical span [start, end) of one page.

    Text-layer pages return PdfBoxes merged per line; OCR pages return the
    boxes of the tokens overlapping the span. An empty result for a non-empty
    span of visible text is a defect the caller should report.
    """
    match = [p for p in layer.pages if p.page == page]
    if not match:
        raise ValueError("page not in layer")
    lp: TextLayerPage = match[0]
    if not 0 <= start < end <= len(lp.text):
        raise ValueError("span out of range")
    if lp.source == "text_layer":
        if lp.char_boxes is None:
            return []
        boxes = unpack_char_boxes(lp.char_boxes)[start:end]
        return [PdfBox(x0=b.x0, y0=b.y0, x1=b.x1, y1=b.y1) for b in merge_line_boxes(boxes)]
    return [t.bbox for t in (lp.tokens or []) if t.start < end and t.end > start]


# --------------------------------------------------------------------------- public OCR


@dataclass
class OcrReadResult:
    pages: list[TextLayerPage]
    critical_tokens: list[CriticalTokenReport]
    ocr_runs: list[OcrRunRow]
    adjudication: list[AdjudicationStats]
    reconciled: list[ReconciledPage]


def _run_engine(engine: OCREngine, image: RasterImage) -> tuple[EngineResult, int]:
    started = time.perf_counter()
    result = engine.recognize(image.to_pil(), ["en"])
    return result, round((time.perf_counter() - started) * 1000)


def read_public_pages(
    pages: Sequence[RasterImage],
    primary: OCREngine,
    secondary: OCREngine,
    *,
    document_id: str,
    input_hash: str | None = None,
    blind_reader: BlindReader | None = None,
    flags: Mapping[str, bool] | None = None,
    config: DocIntelConfig = DEFAULT_CONFIG,
    env: Mapping[str, str] | None = None,
    network_probe: Callable[[], bool] = default_network_probe,
) -> OcrReadResult:
    """Two-engine read of public document pages (flyers, scans, Sponsor files).

    The blind reader is called only for public documents and only when the
    `docintel.blind_read` flag is on. The restricted runtime has no network,
    so inside it pass `blind_reader=None`; the parent then adjudicates the
    returned `reconciled` pages with `adjudicate_page` on the rasters this
    function was given (re-encoded PNGs, not the untrusted original).
    """
    require_isolation(DocumentClass.PUBLIC, env=env, network_probe=network_probe)
    if len(pages) > config.limits.max_ocr_pages:
        raise LimitExceeded(detail=f"pages={len(pages)}")
    flags = flags or {}
    layer_pages: list[TextLayerPage] = []
    reports: list[CriticalTokenReport] = []
    reconciled_pages: list[ReconciledPage] = []
    stats: list[AdjudicationStats] = []
    durations = {primary.name: 0, secondary.name: 0}
    confs: dict[str, list[float]] = {primary.name: [], secondary.name: []}
    versions = {primary.name: primary.version, secondary.name: secondary.version}
    for image in pages:
        a, ta = _run_engine(primary, image)
        b, tb = _run_engine(secondary, image)
        durations[primary.name] += ta
        durations[secondary.name] += tb
        for res in (a, b):
            if res.mean_confidence is not None:
                confs[res.engine].append(res.mean_confidence)
        reconciled: ReconciledPage = check_page(image.page, a, b, config)
        stats.append(
            adjudicate_page(
                reconciled, image, blind_reader, doc_class=DocumentClass.PUBLIC, flags=flags, config=config
            )
        )
        reconciled_pages.append(reconciled)
        layer_pages.append(reconciled.to_layer_page())
        reports.extend(reconciled.reports())
    runs = [
        build_ocr_run(
            stage=OCR_STAGE, engine=name, engine_version=versions[name], config_hash=config.config_hash(),
            input_hash=input_hash, pages=len(pages), duration_ms=durations[name], status="ok",
            rates=config.cost, document_id=document_id,
            mean_confidence=round(sum(confs[name]) / len(confs[name]), 4) if confs[name] else None,
        )
        for name in (primary.name, secondary.name)
    ]
    attempted = sum(s.attempted for s in stats)
    if blind_reader is not None and attempted:
        runs.append(
            build_ocr_run(
                stage=ADJUDICATION_STAGE, engine=blind_reader.name, engine_version="n/a",
                config_hash=config.config_hash(), input_hash=input_hash, pages=len(pages), duration_ms=0,
                status="ok" if not any(s.failures for s in stats) else "partial", rates=config.cost,
                document_id=document_id, model_id=blind_reader.name.removeprefix("llm:"),
                prompt_version=BLIND_READ_PROMPT_VERSION,
            )
        )
    return OcrReadResult(layer_pages, reports, runs, stats, reconciled_pages)
