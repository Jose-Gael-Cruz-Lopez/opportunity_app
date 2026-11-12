"""`ListImporter`: the co-founder's README tables as untrusted hints (plan 4.3, S04-007).

Parses every Markdown table by its header layout and keeps facts only (name, Organization, URL,
listed dates), never list prose. Rows get a stable key: the listings.json id (as a string) when
one matches, otherwise `sha256(norm(org)|norm(name)|url)[:16]`. Every row is a hint: its Source
starts as `pending_approval`, and nothing links out until a Curator verifies it.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

_LINK = re.compile(r"\[([^\]]*)\]\((https?://[^)\s]+)\)")
_BARE_URL = re.compile(r"https?://[^\s|<>)]+")
_HEADING = re.compile(r"^#{1,6}\s+(.*)$")
_SEPARATOR = re.compile(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$")
# Sections the platform does not cover; rows are kept but flagged (s03 3.15 maps them).
OUT_OF_SCOPE = re.compile(r"state grants?|ambassador|incoming freshm[ae]n|high school", re.I)

_NAME_HEADERS = ("program", "name", "opportunity", "title", "role", "fellowship", "scholarship", "internship")
_ORG_HEADERS = ("organization", "company", "org", "sponsor", "host", "institution", "employer")
_URL_HEADERS = ("link", "apply", "url", "application", "website")
_DATE_HEADERS = ("deadline", "date", "due", "closes", "opens", "open", "timeline")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text)).strip()


def row_key(org: str, name: str, url: str) -> str:
    return hashlib.sha256(f"{norm(org)}|{norm(name)}|{url}".encode()).hexdigest()[:16]


@dataclass(frozen=True)
class ListRow:
    key: str
    key_kind: str  # "listings_id" | "hash"
    section: str
    name: str
    organization: str
    url: str
    listed_dates: str
    out_of_scope: bool


def _cells(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", line)]


def _col(headers: Sequence[str], wanted: Iterable[str]) -> int | None:
    lowered = [norm(h) for h in headers]
    for w in wanted:
        for i, h in enumerate(lowered):
            if h == w or h.startswith(w + " ") or h.endswith(" " + w):
                return i
    for w in wanted:
        for i, h in enumerate(lowered):
            if w in h.split():
                return i
    return None


def _plain(cell: str) -> str:
    cell = _LINK.sub(lambda m: m.group(1), cell)
    cell = re.sub(r"<[^>]+>", " ", cell)
    cell = re.sub(r"[*_`]+", "", cell)
    return re.sub(r"\s+", " ", cell).strip()


def _first_url(cells: Sequence[str], preferred: int | None) -> str:
    order = ([preferred] if preferred is not None else []) + [i for i in range(len(cells)) if i != preferred]
    for i in order:
        if i >= len(cells):
            continue
        m = _LINK.search(cells[i]) or _BARE_URL.search(cells[i])
        if m:
            return (m.group(2) if m.re is _LINK else m.group(0)).strip()
    return ""


def parse_readme(markdown: str, listings: Sequence[Mapping[str, Any]] = ()) -> list[ListRow]:
    by_url = {str(item.get("url", "")).strip(): str(item["id"]) for item in listings if item.get("id") and item.get("url")}
    by_name = {norm(str(item.get("title") or item.get("name") or "")): str(item["id"]) for item in listings if item.get("id")}
    rows: list[ListRow] = []
    section = ""
    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        heading = _HEADING.match(lines[i].strip())
        if heading:
            section = _plain(heading.group(1))
        if "|" in lines[i] and i + 1 < len(lines) and _SEPARATOR.match(lines[i + 1].strip()):
            headers = [_plain(h) for h in _cells(lines[i])]
            name_i = _col(headers, _NAME_HEADERS)
            org_i = _col(headers, _ORG_HEADERS)
            url_i = _col(headers, _URL_HEADERS)
            date_cols = [j for j, h in enumerate(headers) if any(w in norm(h).split() for w in _DATE_HEADERS)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                cells = _cells(lines[i])
                name = _plain(cells[name_i]) if name_i is not None and name_i < len(cells) else ""
                org = _plain(cells[org_i]) if org_i is not None and org_i < len(cells) else ""
                url = _first_url(cells, url_i if url_i is not None else name_i)
                dates = "; ".join(_plain(cells[j]) for j in date_cols if j < len(cells) and _plain(cells[j]))
                if name or url:
                    listed = by_url.get(url) or by_name.get(norm(name))
                    rows.append(
                        ListRow(
                            key=listed or row_key(org, name, url),
                            key_kind="listings_id" if listed else "hash",
                            section=section,
                            name=name,
                            organization=org,
                            url=url,
                            listed_dates=dates,
                            out_of_scope=bool(OUT_OF_SCOPE.search(section)),
                        )
                    )
                i += 1
            continue
        i += 1
    return rows


def to_source_upsert(row: ListRow) -> dict[str, Any]:
    """Body for `POST /internal/v1/sources/upsert`: an untrusted list hint awaiting approval."""
    return {
        "kind": "list_row",
        "url": row.url,
        "approval": "pending_approval",
        "externalRef": {"system": "underclassmen_list", "key": row.key, "keyKind": row.key_kind},
        "candidate": {"name": row.name, "organization": row.organization, "listedDates": row.listed_dates},
        "outOfScope": row.out_of_scope,
    }


def to_csv(rows: Sequence[ListRow]) -> str:
    """Workbook seed (CSV until an xlsx writer is a dependency; Novus calls no spreadsheet API)."""
    buf = io.StringIO()
    fields = list(asdict(rows[0]).keys()) if rows else [f for f in ListRow.__dataclass_fields__]
    writer = csv.DictWriter(buf, fieldnames=fields)
    writer.writeheader()
    for r in rows:
        writer.writerow(asdict(r))
    return buf.getvalue()


def load_listings(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return [d for d in (data if isinstance(data, list) else data.get("listings", [])) if isinstance(d, dict)]
