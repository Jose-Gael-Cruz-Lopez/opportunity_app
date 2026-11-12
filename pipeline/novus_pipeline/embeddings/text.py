"""Canonical program text and query keys for the embeddings leg.

A byte-for-byte port of shared/matching/embeddings.ts (`embeddingText`, `embeddingTextHash`,
`normalizeQueryText`, `queryTextHash`) and of `scriptedMisspelling` in shared/matching/eval.ts.
shared/matching/fixtures/embedding-parity.json pins both sides; test_embeddings.py reads it.

Only public card fields are read. Nothing here ever sees student text.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

# Mirrors MATCHING_CONFIG.dense.textVersion. Bump both together; every stored vector goes stale.
TEXT_VERSION = 1
_PROGRAM_TAG = "novus-embed-program"
_QUERY_TAG = "novus-embed-query"

# JS `\s` in a /u regex: Unicode White_Space plus BOM. Python's `\s` (str) is close but also
# matches \x1c-\x1f, which JS does not; list the JS set explicitly so both sides agree.
_JS_WS = (
    "\t\n\v\f\r              "
    "    　﻿"
)
_WS_RE = re.compile("[" + re.escape(_JS_WS) + "]+")
_SLUG_SEP_RE = re.compile(r"[_-]+")


def _clean(value: str) -> str:
    return _WS_RE.sub(" ", unicodedata.normalize("NFKC", value)).strip(_JS_WS)


def _slug_words(values: Sequence[str]) -> str:
    words = [_clean(_SLUG_SEP_RE.sub(" ", v)) for v in values]
    return "; ".join(w for w in words if w)


def _list(card: Mapping[str, Any], key: str) -> list[str]:
    value = card.get(key) or []
    return [str(v) for v in value]


def embedding_text(card: Mapping[str, Any]) -> str:
    """The text a program is embedded from (camelCase ProgramCard keys, as in client-core)."""
    lines = [_clean(str(card.get("name", "")))]
    aliases = [a for a in (_clean(x) for x in _list(card, "aliases")) if a]
    if aliases:
        lines.append("Also known as: " + "; ".join(aliases))
    lines.append("Organization: " + _clean(str(card.get("organizationName", ""))))
    for label, key in (("Type", "opportunityTypes"), ("Fields", "majorFamilies"), ("Topics", "interestTags")):
        words = _slug_words(_list(card, key))
        if words:
            lines.append(f"{label}: {words}")
    summary = _clean(str(card.get("summary") or ""))
    if summary:
        lines.append(summary)
    return "\n".join(lines)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embedding_text_hash(card: Mapping[str, Any], text_version: int = TEXT_VERSION) -> str:
    return _sha256(f"{_PROGRAM_TAG}-v{text_version}\n{embedding_text(card)}")


def normalize_query_text(query: str) -> str:
    # JS toLowerCase and Python lower agree outside a few special-cased letters (e.g. U+0130);
    # labelled queries are team-written, so the parity fixture covers the cases that occur.
    return _clean(query).lower()


def query_text_hash(query: str) -> str:
    return _sha256(f"{_QUERY_TAG}-v1\n{normalize_query_text(query)}")


_LETTERS6_RE = re.compile(r"^[A-Za-z]{6,}$")
_CONSONANT_RE = re.compile(r"[bcdfghjklmnpqrstvwxz]", re.I)
_SPLIT_RE = re.compile(r"\s+")


def scripted_misspelling(text: str) -> str | None:
    """Port of eval.ts scriptedMisspelling: doubles one consonant in the longest word."""
    words = _SPLIT_RE.split(text)
    longest = -1
    for i, w in enumerate(words):
        if _LETTERS6_RE.match(w) and (longest < 0 or len(w) > len(words[longest])):
            longest = i
    if longest < 0:
        return None
    word = words[longest]
    for i in range(math.floor(len(word) * 0.6), len(word)):
        if _CONSONANT_RE.match(word[i]):
            words[longest] = word[: i + 1] + word[i] + word[i + 1 :]
            return " ".join(words)
    return None


def known_item_query_texts(cards: Sequence[Mapping[str, Any]]) -> list[str]:
    """Names, aliases and scripted misspellings: the generated half of the retrieval eval.

    A superset of eval.ts generateKnownItemQueries (every non-empty alias is kept); extra
    vectors cost a fraction of a cent and are simply unused.
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(q: str) -> None:
        key = normalize_query_text(q)
        if key and key not in seen:
            seen.add(key)
            out.append(q)

    for card in cards:
        name = str(card.get("name", ""))
        add(name)
        for alias in _list(card, "aliases"):
            add(alias)
        typo = scripted_misspelling(name)
        if typo:
            add(typo)
    return out
