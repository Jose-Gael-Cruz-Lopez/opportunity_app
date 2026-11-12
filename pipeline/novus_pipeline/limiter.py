"""Per-host spacing and failure pauses (plan 4.5, politeness).

Requests to one host are at least 2 seconds apart (never above one per second), longer under
`Crawl-delay`. The last-request time lives in a mapping shared by every container (a Modal Dict
in production), so spacing holds across jobs; D1 stores no request timing. Five straight
failures pause a host for 6 hours.
"""

from __future__ import annotations

import time
from collections.abc import Callable, MutableMapping

MIN_INTERVAL_SECONDS = 2.0
FAILURE_PAUSE_SECONDS = 6 * 3600
FAILURES_BEFORE_PAUSE = 5


class WaitTooLong(Exception):
    """The host may not be requested again within the caller's wait cap."""

    def __init__(self, seconds: float) -> None:
        super().__init__(f"wait of {seconds:.0f}s exceeds the cap")
        self.seconds = seconds


class HostLimiter:
    def __init__(
        self,
        store: MutableMapping[str, float] | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        # Production passes a shared store and wall-clock time; monotonic is fine in one process.
        self._store: MutableMapping[str, float] = store if store is not None else {}
        self._clock = clock
        self._sleep = sleep

    def wait(self, host: str, crawl_delay: float | None = None, max_wait: float | None = None) -> float:
        """Block until the host may be requested again; returns the seconds slept.

        Raises WaitTooLong, without sleeping or claiming the slot, when the wait would exceed
        `max_wait` (a large Crawl-delay or a request another container just made)."""
        interval = max(MIN_INTERVAL_SECONDS, crawl_delay or 0.0)
        key = f"last:{host}"
        last = self._store.get(key)
        now = self._clock()
        slept = 0.0
        if last is not None and now - last < interval:
            slept = interval - (now - last)
            if max_wait is not None and slept > max_wait:
                raise WaitTooLong(slept)
            self._sleep(slept)
        self._store[key] = self._clock()
        return slept


class HostHealth:
    """Counts consecutive failures per host and pauses a host after five."""

    def __init__(self, store: MutableMapping[str, float] | None = None, *, clock: Callable[[], float] = time.time) -> None:
        self._store: MutableMapping[str, float] = store if store is not None else {}
        self._clock = clock

    def paused_until(self, host: str) -> float | None:
        until = self._store.get(f"pause:{host}")
        return until if until is not None and until > self._clock() else None

    def record_failure(self, host: str) -> bool:
        """Returns True when this failure paused the host."""
        n = int(self._store.get(f"fail:{host}", 0)) + 1
        self._store[f"fail:{host}"] = n
        if n >= FAILURES_BEFORE_PAUSE:
            self._store[f"pause:{host}"] = self._clock() + FAILURE_PAUSE_SECONDS
            self._store[f"fail:{host}"] = 0
            return True
        return False

    def record_success(self, host: str) -> None:
        self._store[f"fail:{host}"] = 0
