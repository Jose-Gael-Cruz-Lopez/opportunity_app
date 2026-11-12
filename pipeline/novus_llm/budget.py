"""Spend caps and the circuit breaker (plan 8.8): reserve before a call, settle after, release
on failure.

Over a cap nothing waits: the call returns `budget_deferred` and the Curator proceeds by hand.

- `InMemoryBudget` enforces caps within one process (laptop runs and tests only: a Modal run is
  a fresh process, so an in-memory cap would reset every scheduled drain).
- `StoreBudget` keeps the month's spend in a shared key-value store (a Modal Dict in production),
  so the caps hold across scheduled runs. Its read-modify-write is not atomic across processes,
  which is why `drain_llm` runs with `max_containers=1`.
- `ClosedBudget` refuses every reservation: production with no durable store fails closed.

The Worker's ledger (`novus-events`, fed by `/internal/v1/llm-calls`) stays the record of what
was spent; a `RemoteBudget` that reserves there replaces `StoreBudget` once the Worker serves a
reservation route (`/internal/v1/llm-budget/reserve`).
"""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class Reservation:
    id: str
    budget_class: str
    amount_usd: float
    month: str


class Budget(Protocol):
    def reserve(self, budget_class: str, amount_usd: float, key: str) -> Reservation | None: ...
    def settle(self, reservation: Reservation, actual_usd: float) -> None: ...
    def release(self, reservation: Reservation) -> None: ...


class KeyValueStore(Protocol):
    """The subset of a mapping that a Modal Dict and a plain dict both offer."""

    def get(self, key: str, default: Any = None) -> Any: ...
    def __setitem__(self, key: str, value: Any) -> None: ...


def _month(ts: float) -> str:
    return time.strftime("%Y-%m", time.gmtime(ts))


TOTAL = "__total__"


class StoreBudget:
    """Month-to-date spend per budget class and in total, kept in `store`.

    Keys: `llm:spent:{YYYY-MM}:{class}` and `llm:spent:{YYYY-MM}:__total__`, in USD. A new month
    starts at zero because its keys do not exist yet."""

    def __init__(
        self,
        store: KeyValueStore,
        class_caps_usd: Mapping[str, float],
        total_cap_usd: float,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._caps = dict(class_caps_usd)
        self._total = total_cap_usd
        self._clock = clock
        self._lock = threading.Lock()

    @staticmethod
    def _key(month: str, budget_class: str) -> str:
        return f"llm:spent:{month}:{budget_class}"

    def _get(self, month: str, budget_class: str) -> float:
        return float(self._store.get(self._key(month, budget_class), 0.0) or 0.0)

    def _add(self, month: str, budget_class: str, delta: float) -> None:
        for c in (budget_class, TOTAL):
            self._store[self._key(month, c)] = max(0.0, self._get(month, c) + delta)

    def reserve(self, budget_class: str, amount_usd: float, key: str) -> Reservation | None:  # noqa: ARG002
        month = _month(self._clock())
        with self._lock:
            cap = self._caps.get(budget_class, 0.0)
            if self._get(month, budget_class) + amount_usd > cap or self._get(month, TOTAL) + amount_usd > self._total:
                return None
            self._add(month, budget_class, amount_usd)
            return Reservation(uuid.uuid4().hex, budget_class, amount_usd, month)

    def settle(self, reservation: Reservation, actual_usd: float) -> None:
        with self._lock:
            self._add(reservation.month, reservation.budget_class, actual_usd - reservation.amount_usd)

    def release(self, reservation: Reservation) -> None:
        self.settle(reservation, 0.0)

    def spent(self, budget_class: str | None = None) -> float:
        return self._get(_month(self._clock()), budget_class or TOTAL)


class InMemoryBudget(StoreBudget):
    """`StoreBudget` over a private dict: caps hold within one process only."""

    def __init__(self, class_caps_usd: Mapping[str, float], total_cap_usd: float, *, clock: Callable[[], float] = time.time) -> None:
        super().__init__({}, class_caps_usd, total_cap_usd, clock=clock)


class ClosedBudget:
    """Refuses every reservation, so the gateway answers `budget_deferred` at no cost."""

    def reserve(self, budget_class: str, amount_usd: float, key: str) -> Reservation | None:  # noqa: ARG002
        return None

    def settle(self, reservation: Reservation, actual_usd: float) -> None:  # pragma: no cover - never reserved
        return None

    def release(self, reservation: Reservation) -> None:  # pragma: no cover - never reserved
        return None


class BreakerBoard:
    """Per-route consecutive failures and open-until times, in `store` when given.

    A shared store keeps the breaker open across scheduled runs; the default dict is per process."""

    def __init__(self, store: KeyValueStore | None = None) -> None:
        self._store: KeyValueStore = store if store is not None else {}

    def open_until(self, route_id: str) -> float:
        return float(self._store.get(f"llm:breaker:{route_id}:open_until", 0.0) or 0.0)

    def failures(self, route_id: str) -> int:
        return int(self._store.get(f"llm:breaker:{route_id}:failures", 0) or 0)

    def record_failure(self, route_id: str, now: float, threshold: int, open_seconds: float) -> None:
        n = self.failures(route_id) + 1
        if n >= threshold:
            self._store[f"llm:breaker:{route_id}:open_until"] = now + open_seconds
            n = 0
        self._store[f"llm:breaker:{route_id}:failures"] = n

    def record_success(self, route_id: str) -> None:
        if self.failures(route_id):
            self._store[f"llm:breaker:{route_id}:failures"] = 0
