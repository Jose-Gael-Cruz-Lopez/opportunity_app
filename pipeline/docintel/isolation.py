"""Isolation rules: where each class of document may be parsed.

Untrusted bytes are parsed only where a compromise reaches neither secrets
nor the network (plan 5.3, 5.4.1, 5.6.1). The rules are enforced three ways:

1. Deploy specs. Every DocIntel runtime is declared here with
   `block_network`, `restrict_modal_access` and `single_use_containers` set
   and no secrets. `validate_spec` rejects any spec that loosens them, and the
   deploy script must build its Modal decorators from `RuntimeSpec.modal_kwargs()`.
2. Runtime guard. `require_isolation()` runs at the top of every entry point
   that touches document bytes. It checks the declared runtime (env
   `NOVUS_DOCINTEL_RUNTIME`, baked into the image), that no secret-like
   environment variable is present, and that the network is unreachable.
3. In-process guard. `deny_network()` patches the socket module for the
   duration of a student document, so a parser bug cannot open a connection
   even if the sandbox flag were ever lost.

Student documents may run only in the per-document sandbox, and never reach
an LLM route (`llm_allowed`).
"""

from __future__ import annotations

import os
import re
import socket
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal

from .errors import IsolationViolation, NetworkDenied

RUNTIME_ENV = "NOVUS_DOCINTEL_RUNTIME"
SECRET_ENV_PATTERN = re.compile(r"KEY|SECRET|TOKEN|PASSWORD|PASSWD|HMAC|DSN|CREDENTIAL|PRIVATE", re.IGNORECASE)


class DocumentClass(StrEnum):
    PUBLIC = "public"  # official PDFs, Curator and Sponsor uploads
    STUDENT = "student"  # anything a student uploaded, until a Curator classifies it


@dataclass(frozen=True)
class RuntimeSpec:
    name: str
    kind: Literal["function", "sandbox"]
    block_network: bool
    restrict_modal_access: bool
    single_use_containers: bool
    secrets: tuple[str, ...]
    cpu: float
    memory_mib: int
    timeout_s: int

    def modal_kwargs(self) -> dict[str, Any]:
        """Keyword arguments for the Modal decorator or Sandbox.create."""
        kwargs: dict[str, Any] = {
            "block_network": self.block_network,
            "cpu": self.cpu,
            "memory": self.memory_mib,
            "timeout": self.timeout_s,
            "secrets": [],
        }
        if self.kind == "function":
            kwargs["restrict_modal_access"] = self.restrict_modal_access
            kwargs["single_use_containers"] = self.single_use_containers
        return kwargs


# The separate Modal App that holds every untrusted-input parser.
RESTRICTED_APP_NAME = "docintel-restricted"

PARSE_PDF = RuntimeSpec("parse_pdf", "function", True, True, True, (), 2.0, 2048, 90)
OCR_IMAGE = RuntimeSpec("ocr_image", "function", True, True, True, (), 2.0, 3072, 120)
STUDENT_SANDBOX = RuntimeSpec("student_sandbox", "sandbox", True, True, True, (), 2.0, 4096, 120)
RUNTIMES: dict[str, RuntimeSpec] = {s.name: s for s in (PARSE_PDF, OCR_IMAGE, STUDENT_SANDBOX)}

ALLOWED_RUNTIMES: dict[DocumentClass, frozenset[str]] = {
    DocumentClass.PUBLIC: frozenset({"parse_pdf", "ocr_image", "student_sandbox"}),
    DocumentClass.STUDENT: frozenset({"student_sandbox"}),
}


def validate_spec(spec: RuntimeSpec, doc_class: DocumentClass) -> None:
    """Raise unless `spec` is a no-network, secret-free runtime allowed for
    this class of document."""
    if not spec.block_network:
        raise IsolationViolation(detail="network_enabled")
    if spec.secrets:
        raise IsolationViolation(detail="secrets_attached")
    if not (spec.single_use_containers and spec.restrict_modal_access):
        raise IsolationViolation(detail="container_reuse_or_modal_access")
    if spec.name not in ALLOWED_RUNTIMES[doc_class]:
        raise IsolationViolation(detail=f"runtime_not_allowed:{spec.name}")
    if doc_class is DocumentClass.STUDENT and spec.kind != "sandbox":
        raise IsolationViolation(detail="student_requires_sandbox")


def secret_like_env_names(env: Mapping[str, str], allowed: frozenset[str] = frozenset()) -> list[str]:
    return sorted(k for k in env if SECRET_ENV_PATTERN.search(k) and k not in allowed)


def default_network_probe(timeout_s: float = 1.0) -> bool:
    """True when an outbound TCP connection succeeds (which must not happen).

    This is the only network attempt DocIntel ever makes, and it exists to
    prove the sandbox flag is effective. Tests always inject a fake probe.
    """
    try:
        with socket.create_connection(("1.1.1.1", 53), timeout=timeout_s):
            return True
    except OSError:
        return False


def require_isolation(
    doc_class: DocumentClass,
    *,
    env: Mapping[str, str] | None = None,
    network_probe: Callable[[], bool] = default_network_probe,
    allowed_env_names: frozenset[str] = frozenset(),
) -> RuntimeSpec:
    """Guard for every entry point that parses document bytes."""
    env = os.environ if env is None else env
    name = env.get(RUNTIME_ENV)
    spec = RUNTIMES.get(name or "")
    if spec is None:
        raise IsolationViolation(detail="runtime_undeclared")
    validate_spec(spec, doc_class)
    if secret_like_env_names(env, allowed_env_names):
        # Names only are reported upstream, never values.
        raise IsolationViolation(detail="secret_env_present")
    if network_probe():
        raise IsolationViolation(detail="network_reachable")
    return spec


def _denied(*_args: object, **_kwargs: object) -> Any:
    raise NetworkDenied(detail="socket")


@contextmanager
def deny_network() -> Iterator[None]:
    """Make every socket connection and DNS lookup in this process fail.

    Process-wide, so use it only in single-use containers or sandboxes that
    handle one document and nothing else.
    """
    saved = (
        socket.socket.connect,
        socket.socket.connect_ex,
        socket.create_connection,
        socket.getaddrinfo,
    )
    socket.socket.connect = _denied  # type: ignore[method-assign]
    socket.socket.connect_ex = _denied  # type: ignore[method-assign]
    socket.create_connection = _denied  # type: ignore[assignment]
    socket.getaddrinfo = _denied  # type: ignore[assignment]
    try:
        yield
    finally:
        (
            socket.socket.connect,  # type: ignore[method-assign]
            socket.socket.connect_ex,  # type: ignore[method-assign]
            socket.create_connection,
            socket.getaddrinfo,
        ) = saved


def llm_allowed(doc_class: DocumentClass, flags: Mapping[str, bool]) -> bool:
    """Only public documents may reach an LLM route, and only behind a flag.

    Student content stays off every LLM route: no retention basis exists, the
    Gemini terms forbid personal data on unpaid keys, and the under-18 terms
    question is open (founder and counsel decision).
    """
    if doc_class is DocumentClass.STUDENT:
        return False
    return bool(flags.get("docintel.blind_read", False))
