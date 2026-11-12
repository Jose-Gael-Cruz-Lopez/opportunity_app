"""Deterministic risk signals (plan 4.8, REQ-048). Not the model, and never the word "scam".

Each signal carries the quote that triggered it. The Worker's `scoreRisk()` weighs them and opens
`scam_flag` tasks above a private threshold; public copy never labels a program.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

from .policy import normalize_host

URL_SHORTENERS = frozenset(
    {"bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
     "shorturl.at", "rb.gy", "tiny.cc", "lnkd.in", "s.id"}
)  # fmt: skip
FREE_MAIL = frozenset({"gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "proton.me", "icloud.com"})

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("application_fee", re.compile(r"\b(?:application|processing|registration|enrollment) fee\b[^.]{0,60}?\$\s?\d+|\$\s?\d+[^.]{0,40}?\b(?:application|processing) fee\b", re.I)),
    ("gift_card_payment", re.compile(r"\bgift ?cards?\b", re.I)),
    ("wire_payment", re.compile(r"\bwire (?:transfer|the (?:funds|money|fee))\b|\bwestern union\b|\bmoneygram\b", re.I)),
    ("crypto_payment", re.compile(r"\b(?:bitcoin|btc|crypto(?:currency)?|usdt|ethereum)\b", re.I)),
    ("payment_app", re.compile(r"\b(?:venmo|cash ?app|zelle|paypal friends)\b", re.I)),
    ("ssn_request", re.compile(r"\b(?:social security number|ssn)\b", re.I)),
    ("bank_details_request", re.compile(r"\b(?:bank account (?:number|details)|routing number|credit card number|debit card number)\b", re.I)),
    ("fsa_id_request", re.compile(r"\bfsa ?id\b", re.I)),
    ("messaging_app_contact", re.compile(r"\b(?:whatsapp|telegram|signal app|wechat)\b", re.I)),
    ("guaranteed_award", re.compile(r"\bguarantee(?:d)?\b[^.]{0,40}\b(?:award|scholarship|winner|selection|placement|money)\b", re.I)),
)
_URL = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@([\w-]+(?:\.[\w-]+)+)\b")


@dataclass(frozen=True)
class RiskSignal:
    code: str
    quote: str
    start: int
    end: int


def _registrable(host: str) -> str:
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def _within(host: str, domains: Iterable[str]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def _edit1(a: str, b: str) -> bool:
    """True when a and b differ by one substitution, insertion, deletion or adjacent swap."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diffs = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diffs) == 1 or (len(diffs) == 2 and diffs[1] == diffs[0] + 1 and a[diffs[0]] == b[diffs[1]] and a[diffs[1]] == b[diffs[0]])
    short, long_ = (a, b) if len(a) < len(b) else (b, a)
    return any(long_[:i] + long_[i + 1 :] == short for i in range(len(long_)))


def lookalike(host: str, official: Sequence[str]) -> str | None:
    """The official domain `host` imitates (one edit away, punycode, or official label reused)."""
    host = normalize_host(host)
    reg = _registrable(host)
    for dom in official:
        d = normalize_host(dom)
        if _within(host, [d]):
            return None
    for dom in official:
        d = normalize_host(dom)
        d_label = d.split(".")[0]
        if _edit1(reg, d) or (host.startswith("xn--") or ".xn--" in host) or (d_label in host.split(".")[:-2] and len(d_label) >= 4):
            return d
    return None


def detect(
    text: str,
    *,
    official_domains: Sequence[str] = (),
    platform_domains: Sequence[str] = (),
) -> list[RiskSignal]:
    """Quoted risk signals in public page text. Official domains narrow the link checks."""
    out: list[RiskSignal] = []
    for code, pattern in _PATTERNS:
        for m in pattern.finditer(text):
            out.append(RiskSignal(code, m.group(0), m.start(), m.end()))
    for m in _URL.finditer(text):
        host = normalize_host(urlsplit(m.group(0)).hostname or "")
        if not host:
            continue
        if host in URL_SHORTENERS:
            out.append(RiskSignal("url_shortener", m.group(0), m.start(), m.end()))
        if official_domains and re.search(r"apply|application|register", text[max(0, m.start() - 80) : m.start()], re.I):
            if not _within(host, [*official_domains, *platform_domains]):
                out.append(RiskSignal("off_domain_apply_link", m.group(0), m.start(), m.end()))
        if official_domains and lookalike(host, official_domains):
            out.append(RiskSignal("lookalike_domain", m.group(0), m.start(), m.end()))
    for m in _EMAIL.finditer(text):
        dom = m.group(1).lower()
        if dom in FREE_MAIL and official_domains:
            out.append(RiskSignal("personal_contact_for_organization", m.group(0), m.start(), m.end()))
    return sorted(out, key=lambda s: (s.start, s.code))
