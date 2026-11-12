"""Price table for cost accounting and budget reservations (USD per 1M tokens).

Mirrors server/ai/config.ts MODELS prices (checked against the Gemini pricing page on 2026-11-11),
so the Worker and the pipeline price one call the same way. Prices change on known dates, so each
model carries a dated list. `PRICE_TABLE_VERSION` is recorded on every call so a correction can
be re-applied later. Thinking tokens bill as output. Cached input is charged at the full input
rate here, which over-counts slightly and keeps reservations conservative. A model outside the
table (a served version string we do not recognise) is priced at the dearest allowlisted rate.
"""

from __future__ import annotations

import time
from datetime import UTC, date, datetime

PRICE_TABLE_VERSION = "gemini-2026-11-11"

# model -> [(effective from, inclusive), (input, output) USD per 1M tokens], oldest first.
PRICES: dict[str, list[tuple[date, tuple[float, float]]]] = {
    "gemini-3.5-flash-lite": [(date(2026, 7, 1), (0.30, 2.50))],
    "gemini-3.1-flash-lite": [(date(2026, 1, 1), (0.25, 1.50))],
    "gemini-3.8-flash": [(date(2026, 1, 1), (0.75, 3.75)), (date(2027, 1, 1), (1.50, 7.50))],
    "gemini-3.6-flash": [(date(2026, 1, 1), (0.75, 3.75)), (date(2027, 1, 1), (1.50, 7.50))],
}
# server/ai/config.ts CONSERVATIVE_PRICE: never cheaper than the dearest allowlisted model.
CEILING: tuple[float, float] = (1.50, 7.50)


def _today() -> date:
    return datetime.fromtimestamp(time.time(), UTC).date()


def rates(model: str, on: date | None = None) -> tuple[float, float]:
    """(input, output) USD per 1M tokens in force on `on` (default today, UTC).

    Served versions may carry a suffix (`gemini-3.5-flash-lite-001`), so the longest table key
    that prefixes the id wins."""
    matches = [k for k in PRICES if model == k or model.startswith(k + "-")]
    if not matches:
        return CEILING
    day = on or _today()
    current = CEILING
    for start, price in PRICES[max(matches, key=len)]:
        if start <= day:
            current = price
    return current


def cost_usd(model: str, input_tokens: int, output_tokens: int, thinking_tokens: int = 0, *, on: date | None = None) -> float:
    inp, out = rates(model, on)
    return (input_tokens * inp + (output_tokens + thinking_tokens) * out) / 1_000_000


def to_micros(usd: float) -> int:
    """Integer micro-USD for the Worker's ledger (costMicros), never negative."""
    return max(0, round(usd * 1_000_000))


def estimate_tokens(text_chars: int) -> int:
    """About four characters per token for English, plus 10% headroom."""
    return int(text_chars / 4 * 1.1) + 1


def reservation_usd(model: str, input_chars: int, max_output_tokens: int, *, on: date | None = None) -> float:
    """Worst case for one attempt: estimated input plus the whole output budget."""
    inp, out = rates(model, on)
    return (estimate_tokens(input_chars) * inp + max_output_tokens * out) / 1_000_000
