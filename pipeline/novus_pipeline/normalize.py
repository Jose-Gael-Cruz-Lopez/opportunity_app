"""HTML normalizer: canonical text, watch text, hidden channel and hashes (plan 4.5).

In production this runs inside a no-network, no-secret, single-use Modal function, because lxml
parses attacker-controlled bytes; see `modal_app.normalize_html_restricted`. The function is pure:
bytes in, `NormalizedDoc` out.

Three text channels:
- canonical text: the main content, including text revealed by disclosure widgets (accordions,
  tab panels, `hidden="until-found"`). This is the only text a model ever sees.
- watch text: everything visible except navigation and footers, so banners, alerts, asides and
  news teasers ("Deadline extended", "Applications paused") are seen by the change detector even
  though main-content extraction drops them. Never sent to a model.
- hidden channel: text hidden inline (`display:none`, `visibility:hidden`, zero size, off-screen)
  with no disclosure control. A quote found only here raises HIDDEN_TEXT.

`aria-hidden` is an accessibility attribute, not a visibility one, so it hides nothing.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from lxml import etree, html

from .lexicon import apply_masks, compile_masks, key_windows, status_pattern, watch_tokens
from .textnorm import normalize_inline, normalize_text, sha256_hex

NORMALIZER_VERSION = "html-1.0.0"
MAX_JSONLD_BLOCKS = 10
MAX_JSONLD_BYTES = 200_000

_DROP_TAGS = frozenset(
    {"script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed",
     "canvas", "head", "select", "button", "input", "textarea", "video", "audio", "picture", "img"}
)  # fmt: skip
_BLOCK_TAGS = frozenset(
    {"p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol",
     "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "h1", "h2", "h3", "h4",
     "h5", "h6", "blockquote", "pre", "figure", "figcaption", "form", "fieldset", "details",
     "summary", "address", "hr", "body", "html", "caption"}
)  # fmt: skip
_CELL_TAGS = frozenset({"td", "th"})
_NAV_ROLES = frozenset({"navigation", "contentinfo"})
_NONMAIN_ROLES = frozenset({"navigation", "contentinfo", "banner", "complementary", "alert", "status", "search"})
# Class or id tokens that main-content extractors discard (trafilatura's xpaths use similar
# tokens). Text under them stays in the watch text, which is the point of the watch channel.
_NONMAIN_TOKENS = re.compile(
    r"(?:^|[-_ ])(?:banner|sidebar|side-bar|nav|navbar|menu|footer|breadcrumbs?|cookie|consent|share"
    r"|social|teaser|promo|related|comments?|newsletter|skip|alert|message|notice|announcement"
    r"|masthead|toolbar|ad|ads|advert)(?:$|[-_ ])",
    re.I,
)
_SUSPECT_TOKENS = re.compile(
    r"(?:^|[-_ ])(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|d-none|hidden|hide"
    r"|offscreen|off-screen|invisible|clip)(?:$|[-_ ])",
    re.I,
)
_STYLE_HIDDEN = re.compile(
    r"display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:;|$)"
    r"|(?:left|top|right|text-indent)\s*:\s*-\d{3,}(?:px|em|rem)"
    r"|clip\s*:\s*rect\(\s*0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?\s*\)",
    re.I,
)
_STYLE_ZERO_W = re.compile(r"(?:^|;)\s*(?:max-)?width\s*:\s*0(?:px)?\s*(?:;|$)", re.I)
_STYLE_ZERO_H = re.compile(r"(?:^|;)\s*(?:max-)?height\s*:\s*0(?:px)?\s*(?:;|$)", re.I)


class NormalizeError(ValueError):
    """The bytes could not be parsed as a document with any text."""


@dataclass(frozen=True)
class NormalizedDoc:
    normalizer_version: str
    title: str
    canonical_text: str
    watch_text: str
    hidden_text: str
    # Character ranges of canonical text under class names that usually hide content through
    # external CSS (sr-only, d-none); quotes there get HIDDEN_TEXT_SUSPECT.
    suspect_ranges: tuple[tuple[int, int], ...]
    # Hash of the canonical text with volatile parts masked: for change detection only, since two
    # Snapshots that differ only in a volatile part ("Updated Nov 9") share it.
    main_text_sha256: str
    watch_tokens_sha256: str
    key_windows_sha256: str
    key_windows: tuple[str, ...]
    jsonld: tuple[dict[str, Any], ...] = field(default=())
    # Hash of the exact canonical_text: the content address for storing that text, so evidence
    # offsets always point into the string they were computed on.
    canonical_text_sha256: str = ""

    def visible_contains(self, quote: str) -> bool:
        q = normalize_inline(quote)
        return bool(q) and (q in _flat(self.canonical_text) or q in _flat(self.watch_text))


def _flat(text: str) -> str:
    return text.replace("\n", " ")


class _Builder:
    """Collects text segments per line and joins them the way a browser would render spacing."""

    def __init__(self) -> None:
        self._lines: list[list[tuple[str, bool]]] = [[]]

    def add(self, text: str, suspect: bool) -> None:
        if text:
            self._lines[-1].append((text, suspect))

    def newline(self) -> None:
        if self._lines[-1]:
            self._lines.append([])

    def build(self) -> tuple[str, tuple[tuple[int, int], ...]]:
        out_lines: list[str] = []
        ranges: list[tuple[int, int]] = []
        offset = 0
        for segments in self._lines:
            line = ""
            local_ranges: list[tuple[int, int]] = []
            pending_space = False
            for raw, suspect in segments:
                core = normalize_inline(raw)
                if not core:
                    pending_space = pending_space or raw[:1].isspace() or raw.isspace()
                    continue
                if line and (pending_space or raw[:1].isspace()):
                    line += " "
                start = len(line)
                line += core
                if suspect:
                    local_ranges.append((start, len(line)))
                pending_space = raw[-1:].isspace()
            if not line:
                continue
            if out_lines:
                offset += 1  # the joining newline
            ranges.extend((offset + a, offset + b) for a, b in local_ranges)
            out_lines.append(line)
            offset += len(line)
        return "\n".join(out_lines), tuple(ranges)


def _tokens(el: etree._Element) -> str:
    return f"{el.get('class') or ''} {el.get('id') or ''}".strip()


def _inline_hidden(el: etree._Element) -> bool:
    if el.get("hidden") is not None and (el.get("hidden") or "").lower() != "until-found":
        return True
    style = el.get("style") or ""
    if not style:
        return False
    if _STYLE_HIDDEN.search(style):
        return True
    return bool(_STYLE_ZERO_W.search(style) and _STYLE_ZERO_H.search(style))


def _revealed(el: etree._Element, controlled: frozenset[str]) -> bool:
    """Content a reader can reach by interacting: kept in canonical text despite hiding."""
    if (el.get("hidden") or "").lower() == "until-found":
        return True
    if (el.get("role") or "").lower() == "tabpanel":
        return True
    el_id = el.get("id")
    return bool(el_id and el_id in controlled)


@dataclass
class _Ctx:
    hidden: bool = False
    nav: bool = False
    nonmain: bool = False
    suspect: bool = False


class _Walker:
    def __init__(self, main_root: etree._Element | None, controlled: frozenset[str]) -> None:
        self.main_root = main_root
        self.controlled = controlled
        self.canonical = _Builder()
        self.watch = _Builder()
        self.hidden = _Builder()
        self._in_main_depth = 0

    def _emit(self, text: str | None, ctx: _Ctx) -> None:
        if not text:
            return
        if ctx.hidden:
            self.hidden.add(text, False)
            return
        if not ctx.nav:
            self.watch.add(text, ctx.suspect)
        if self._in_main_depth and not ctx.nonmain:
            self.canonical.add(text, ctx.suspect)

    def _break(self) -> None:
        self.canonical.newline()
        self.watch.newline()
        self.hidden.newline()

    def walk(self, el: etree._Element, ctx: _Ctx) -> None:
        tag = el.tag if isinstance(el.tag, str) else ""
        tag = tag.lower()
        if not tag or tag in _DROP_TAGS:
            return
        role = (el.get("role") or "").lower()
        tokens = _tokens(el)
        child_ctx = _Ctx(
            hidden=ctx.hidden or (_inline_hidden(el) and not _revealed(el, self.controlled)),
            nav=ctx.nav or tag in ("nav", "footer") or role in _NAV_ROLES,
            nonmain=ctx.nonmain
            or tag in ("nav", "footer", "aside", "header", "form")
            or role in _NONMAIN_ROLES
            or bool(tokens and _NONMAIN_TOKENS.search(tokens)),
            suspect=ctx.suspect or bool(tokens and _SUSPECT_TOKENS.search(tokens)),
        )
        is_main = el is self.main_root
        if is_main:
            self._in_main_depth += 1
        block = tag in _BLOCK_TAGS
        if block or tag == "br":
            self._break()
        self._emit(el.text, child_ctx)
        for child in el:
            self.walk(child, child_ctx)
            if isinstance(child.tag, str) and child.tag.lower() in _CELL_TAGS:
                self._emit(" ", child_ctx)
            self._emit(child.tail, child_ctx)
        if block:
            self._break()
        if is_main:
            self._in_main_depth -= 1


def _find_main(root: etree._Element) -> etree._Element | None:
    for xpath in ("//main", "//*[@role='main']"):
        found = root.xpath(xpath)
        if found:
            return found[0]
    articles = root.xpath("//article")
    if len(articles) == 1:
        return articles[0]
    body = root.find(".//body")
    return body if body is not None else root


def _controlled_ids(root: etree._Element) -> frozenset[str]:
    ids: set[str] = set()
    for el in root.xpath("//*[@aria-expanded][@aria-controls]"):
        ids.update((el.get("aria-controls") or "").split())
    return frozenset(ids)


def _jsonld(root: etree._Element) -> tuple[dict[str, Any], ...]:
    out: list[dict[str, Any]] = []
    for script in root.xpath("//script[@type='application/ld+json']")[:MAX_JSONLD_BLOCKS]:
        raw = (script.text or "").strip()
        if not raw or len(raw) > MAX_JSONLD_BYTES:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            graph = item.get("@graph")
            if isinstance(graph, list):
                out.extend(g for g in graph if isinstance(g, dict))
            else:
                out.append(item)
    return tuple(out)


def _charset(content_type: str | None) -> str | None:
    if not content_type:
        return None
    m = re.search(r"charset=([\w.:-]+)", content_type, re.I)
    return m.group(1).lower() if m else None


def normalize_html(
    raw: bytes,
    content_type: str | None = None,
    *,
    volatile_patterns: Sequence[str] = (),
    extra_status_terms: Sequence[str] = (),
) -> NormalizedDoc:
    """Parse untrusted HTML bytes into the three text channels and their hashes."""
    if not raw.strip():
        raise NormalizeError("empty document")
    parser = html.HTMLParser(
        encoding=_charset(content_type),
        huge_tree=False,  # libxml2's limits stay on for untrusted input
        remove_comments=True,
        remove_pis=True,
        no_network=True,
    )
    try:
        root = html.document_fromstring(raw, parser=parser)
    except (etree.ParserError, ValueError) as exc:
        raise NormalizeError("unparseable document") from exc
    jsonld = _jsonld(root)
    title_el = root.find(".//title")
    title = normalize_inline(title_el.text_content()) if title_el is not None else ""

    walker = _Walker(_find_main(root), _controlled_ids(root))
    walker.walk(root, _Ctx())
    canonical, suspect = walker.canonical.build()
    watch, _ = walker.watch.build()
    hidden, _ = walker.hidden.build()
    if not canonical and not watch:
        raise NormalizeError("no visible text")
    return _finish(title, canonical, watch, hidden, suspect, jsonld, volatile_patterns, extra_status_terms)


def normalize_plain_text(
    text: str, *, volatile_patterns: Sequence[str] = (), extra_status_terms: Sequence[str] = ()
) -> NormalizedDoc:
    """For text/plain Sources and for text layers produced elsewhere (s05 for PDFs)."""
    canonical = normalize_text(text)
    if not canonical:
        raise NormalizeError("no visible text")
    return _finish("", canonical, canonical, "", (), (), volatile_patterns, extra_status_terms)


def _finish(
    title: str,
    canonical: str,
    watch: str,
    hidden: str,
    suspect: tuple[tuple[int, int], ...],
    jsonld: tuple[dict[str, Any], ...],
    volatile_patterns: Sequence[str],
    extra_status_terms: Sequence[str],
) -> NormalizedDoc:
    masks = compile_masks(volatile_patterns)
    pattern = status_pattern(extra_status_terms)
    masked_main = normalize_text(apply_masks(canonical, masks))
    masked_watch = normalize_text(apply_masks(watch, masks))
    windows = tuple(key_windows(masked_main, pattern))
    return NormalizedDoc(
        normalizer_version=NORMALIZER_VERSION,
        title=title,
        canonical_text=canonical,
        watch_text=watch,
        hidden_text=hidden,
        suspect_ranges=suspect,
        main_text_sha256=sha256_hex(masked_main),
        watch_tokens_sha256=sha256_hex("\n".join(watch_tokens(masked_watch, pattern))),
        key_windows_sha256=sha256_hex("\n".join(windows)),
        key_windows=windows,
        jsonld=jsonld,
        canonical_text_sha256=sha256_hex(canonical),
    )
