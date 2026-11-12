"""DocIntel: document intelligence for Novus.

Turns documents into evidence-backed proposals. It never publishes: a
Curator verifying against an official Snapshot stands between any document
and a verified record.

Cascade: PDF text layer (PDFium, cross-read by pdfplumber) -> two local OCR
engines that must agree exactly on critical tokens -> blind LLM read of
disputed spans (public documents only) -> a person.
"""

from .adjudicate import BlindReader, NovusLlmBlindReader, StructuredImageLlm, adjudicate_page
from .api import OcrReadResult, ParseResult, locate, parse_pdf, read_public_pages
from .config import DEFAULT_CONFIG, DocIntelConfig
from .critical import recognize
from .engines.base import EngineResult, OCREngine, OcrLine, OcrWord
from .isolation import DocumentClass, deny_network, llm_allowed, require_isolation, validate_spec
from .letters import LetterResults, check_student_letter
from .raster import PageRasterizer, PdfiumRasterizer, RasterImage, compute_render_dpi, crop_for_blind_read
from .reconcile import check_page, reconcile_fields

__all__ = [
    "DEFAULT_CONFIG",
    "BlindReader",
    "DocIntelConfig",
    "DocumentClass",
    "EngineResult",
    "LetterResults",
    "NovusLlmBlindReader",
    "OCREngine",
    "OcrLine",
    "OcrReadResult",
    "OcrWord",
    "PageRasterizer",
    "ParseResult",
    "PdfiumRasterizer",
    "RasterImage",
    "StructuredImageLlm",
    "adjudicate_page",
    "check_page",
    "check_student_letter",
    "compute_render_dpi",
    "crop_for_blind_read",
    "deny_network",
    "llm_allowed",
    "locate",
    "parse_pdf",
    "read_public_pages",
    "recognize",
    "reconcile_fields",
    "require_isolation",
    "validate_spec",
]
