"""Test setup for DocIntel: import path, isolation fakes, no network.

Tests never touch the network. Entry points that call `require_isolation`
get a fake runtime environment and a network probe that reports "blocked".
"""

from __future__ import annotations

import socket
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

PIPELINE_DIR = Path(__file__).resolve().parents[2]
TESTS_DIR = Path(__file__).resolve().parent
for p in (str(PIPELINE_DIR), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)


def blocked_probe() -> bool:
    return False


@pytest.fixture
def public_env() -> dict[str, str]:
    return {"NOVUS_DOCINTEL_RUNTIME": "parse_pdf", "PATH": "/usr/bin"}


@pytest.fixture
def ocr_env() -> dict[str, str]:
    return {"NOVUS_DOCINTEL_RUNTIME": "ocr_image"}


@pytest.fixture
def student_env() -> dict[str, str]:
    return {"NOVUS_DOCINTEL_RUNTIME": "student_sandbox"}


@pytest.fixture(autouse=True)
def _no_real_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Fail loudly if any test tries a real outbound connection."""

    def refuse(*_a: object, **_k: object) -> None:
        raise AssertionError("tests must not use the network")

    monkeypatch.setattr(socket, "create_connection", refuse)
    yield
