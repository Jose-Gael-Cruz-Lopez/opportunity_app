"""A scripted provider for tests and offline evaluation dry-runs. Records calls; no network."""

from __future__ import annotations

from collections.abc import Callable, Sequence

from .base import GenerateCall, ProviderError, ProviderResult


class FakeProvider:
    name = "fake"

    def __init__(self, script: Sequence[ProviderResult | ProviderError | Callable[[GenerateCall], ProviderResult]]) -> None:
        self._script = list(script)
        self.calls: list[GenerateCall] = []

    def generate(self, call: GenerateCall) -> ProviderResult:
        self.calls.append(call)
        if not self._script:
            raise ProviderError("script exhausted", retryable=False)
        step = self._script.pop(0)
        if isinstance(step, ProviderError):
            raise step
        if callable(step) and not isinstance(step, ProviderResult):
            return step(call)
        return step
