"""Pydantic mirrors of the DocIntel data contracts (TextLayer v1, locators, OCRRun).

The source of truth is the zod file `shared/contracts/text-layer.v1.ts`; these
models must match it field for field (camelCase on the wire). Until the
build generates them from zod, keep the two in step by hand.

Every model forbids unknown keys and hides input values in validation
errors, so a ValidationError raised on document content never carries that
content into a log (plan 5.8).
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Contract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        hide_input_in_errors=True,
        populate_by_name=True,
        alias_generator=to_camel,
        frozen=False,
    )

    def to_wire(self) -> dict[str, object]:
        """JSON-ready dict with camelCase keys and optional fields omitted."""
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


TokenClass = Literal["DATE", "TIME", "URL", "EMAIL", "NUMBER", "ELIG_TERM"]
Agreement = Literal["agreed", "disputed", "single"]
HiddenReason = Literal[
    "render_mode", "outside_cropbox", "tiny", "near_white", "low_contrast", "occluded", "optional_content"
]
Triage = Literal["born_digital", "no_text_layer", "image"]


class BBox(Contract):
    """Image box, normalized 0-1, top-left origin."""

    x0: float
    y0: float
    x1: float
    y1: float


class PdfBox(Contract):
    """PDF points from the CropBox's lower-left corner, before /Rotate."""

    x0: float
    y0: float
    x1: float
    y1: float


class Reading(Contract):
    reader: str
    text: str


class OcrToken(Contract):
    text: str
    start: int
    end: int
    bbox: BBox
    readers: list[str]
    cls: TokenClass | None = None
    agreement: Agreement
    readings: list[Reading] | None = None


class HiddenSpan(Contract):
    start: int
    end: int
    text: str
    reason: HiddenReason


class TextLayerPage(Contract):
    page: int
    source: Literal["text_layer", "ocr"]
    text: str
    crop_box: tuple[float, float, float, float] | None = None
    rotate: Literal[0, 90, 180, 270] | None = None
    char_boxes: str | None = None
    tokens: list[OcrToken] | None = None
    hidden: list[HiddenSpan]


class QrFinding(Contract):
    page: int
    bbox: BBox
    payload: str


class TextLayer(Contract):
    version: Literal[1] = 1
    sha256: str
    triage: Triage
    language: str
    pages: list[TextLayerPage]
    qr: list[QrFinding]
    ocr_run_ids: list[str]


# Evidence locators (stored in FieldEvidence.locator). Only html and pdf_text
# into an official Snapshot can verify a field; the rest are hint evidence.
class HtmlLocator(Contract):
    kind: Literal["html"]
    snapshot_id: str
    char_start: int
    char_end: int


class PdfTextLocator(Contract):
    kind: Literal["pdf_text"]
    snapshot_id: str
    page: int
    char_start: int
    char_end: int
    boxes: list[PdfBox]


class UploadTextLocator(Contract):
    kind: Literal["upload_text"]
    document_id: str
    page: int
    char_start: int
    char_end: int
    boxes: list[PdfBox]


class OcrImageLocator(Contract):
    kind: Literal["ocr_image"]
    document_id: str
    page: int
    char_start: int
    char_end: int
    bboxes: list[BBox]
    agreement: Agreement
    readers: list[str]


class QrLocator(Contract):
    kind: Literal["qr"]
    document_id: str
    page: int
    bbox: BBox
    payload: str
    official_snapshot_id: str | None = None


EvidenceLocator = Annotated[
    HtmlLocator | PdfTextLocator | UploadTextLocator | OcrImageLocator | QrLocator,
    Field(discriminator="kind"),
]

VERIFYING_LOCATOR_KINDS = frozenset({"html", "pdf_text"})


def is_verifying_locator_kind(kind: str) -> bool:
    """Mirror of the TS `isVerifyingLocatorKind`: only html and pdf_text verify."""
    return kind in VERIFYING_LOCATOR_KINDS


OcrRunStatus = Literal["ok", "partial", "failed"]


class OcrRunRow(Contract):
    """One `ocr_runs` row. It never stores document text (plan 5.7)."""

    id: str
    snapshot_id: str | None = None
    document_id: str | None = None
    stage: str
    engine: str
    engine_version: str
    model_id: str | None = None
    effort: str | None = None
    prompt_version: str | None = None
    config_hash: str
    input_hash: str | None = None
    pages: int
    duration_ms: int
    mean_confidence: float | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    cost_micro_usd: int | None = None
    status: OcrRunStatus
    error_code: str | None = None
    created_at: str


class CriticalTokenReport(Contract):
    """A critical token with every reading and its confidence, for the
    `:complete` payload and the Curator task. Confidence is the raw engine
    confidence (uncalibrated); agreement, not confidence, decides prefill."""

    page: int
    cls: TokenClass
    norm: str
    text: str
    start: int
    end: int
    bbox: BBox
    agreement: Agreement
    readers: list[str]
    readings: list[Reading]
    confidence: float | None = None
    adjudicated: bool = False


class PageQuality(Contract):
    """Text-layer quality signals per page; diagnostics, not part of TextLayer."""

    page: int
    printable_chars: int
    tokens: int
    garbage_tokens: int
    garbage_ratio: float
    unicode_map_errors: int
    has_images: bool
    cross_reader_agreement: float | None
    hidden_chars: int
    status: Literal["born_digital", "blank", "failing"]
    score: float
