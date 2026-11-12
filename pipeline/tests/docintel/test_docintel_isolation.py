from __future__ import annotations

import socket
from dataclasses import replace

import pytest

from docintel.errors import IsolationViolation, NetworkDenied
from docintel.isolation import (
    OCR_IMAGE,
    PARSE_PDF,
    RESTRICTED_APP_NAME,
    RUNTIMES,
    STUDENT_SANDBOX,
    DocumentClass,
    deny_network,
    llm_allowed,
    require_isolation,
    validate_spec,
)

from conftest import blocked_probe


def test_every_declared_runtime_blocks_network_and_has_no_secrets() -> None:
    assert RESTRICTED_APP_NAME == "docintel-restricted"
    for spec in RUNTIMES.values():
        kwargs = spec.modal_kwargs()
        assert kwargs["block_network"] is True
        assert kwargs["secrets"] == []
        if spec.kind == "function":
            assert kwargs["restrict_modal_access"] is True and kwargs["single_use_containers"] is True
    assert (PARSE_PDF.memory_mib, PARSE_PDF.timeout_s) == (2048, 90)
    assert (OCR_IMAGE.memory_mib, OCR_IMAGE.timeout_s) == (3072, 120)
    assert (STUDENT_SANDBOX.kind, STUDENT_SANDBOX.memory_mib) == ("sandbox", 4096)


@pytest.mark.parametrize(
    "spec",
    [
        replace(STUDENT_SANDBOX, block_network=False),
        replace(STUDENT_SANDBOX, secrets=("GEMINI_API_KEY",)),
        replace(STUDENT_SANDBOX, single_use_containers=False),
        PARSE_PDF,
        OCR_IMAGE,
    ],
)
def test_student_documents_need_the_no_network_sandbox(spec) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(IsolationViolation):
        validate_spec(spec, DocumentClass.STUDENT)


def test_public_specs_validate() -> None:
    for spec in RUNTIMES.values():
        validate_spec(spec, DocumentClass.PUBLIC)
    with pytest.raises(IsolationViolation):
        validate_spec(replace(PARSE_PDF, block_network=False), DocumentClass.PUBLIC)


def test_require_isolation_paths() -> None:
    ok = require_isolation(DocumentClass.STUDENT, env={"NOVUS_DOCINTEL_RUNTIME": "student_sandbox"},
                           network_probe=blocked_probe)
    assert ok is STUDENT_SANDBOX
    cases = [
        ({}, blocked_probe, "runtime_undeclared"),
        ({"NOVUS_DOCINTEL_RUNTIME": "nope"}, blocked_probe, "runtime_undeclared"),
        ({"NOVUS_DOCINTEL_RUNTIME": "ocr_image"}, blocked_probe, "runtime_not_allowed"),
        ({"NOVUS_DOCINTEL_RUNTIME": "student_sandbox", "GEMINI_API_KEY": "placeholder"}, blocked_probe,
         "secret_env_present"),
        ({"NOVUS_DOCINTEL_RUNTIME": "student_sandbox", "INTERNAL_HMAC_KEYS": "{}"}, blocked_probe,
         "secret_env_present"),
        ({"NOVUS_DOCINTEL_RUNTIME": "student_sandbox"}, lambda: True, "network_reachable"),
    ]
    for env, probe, code in cases:
        with pytest.raises(IsolationViolation) as info:
            require_isolation(DocumentClass.STUDENT, env=env, network_probe=probe)
        assert code in str(info.value)


def test_violation_message_never_contains_secret_values() -> None:
    with pytest.raises(IsolationViolation) as info:
        require_isolation(DocumentClass.STUDENT,
                          env={"NOVUS_DOCINTEL_RUNTIME": "student_sandbox", "API_TOKEN": "QZX-secret-value"},
                          network_probe=blocked_probe)
    assert "QZX" not in str(info.value)


def test_allowed_env_names_escape_hatch() -> None:
    env = {"NOVUS_DOCINTEL_RUNTIME": "student_sandbox", "MODAL_TASK_TOKEN_ID": "x"}
    require_isolation(DocumentClass.STUDENT, env=env, network_probe=blocked_probe,
                      allowed_env_names=frozenset({"MODAL_TASK_TOKEN_ID"}))


def test_deny_network_blocks_sockets_and_dns_then_restores() -> None:
    before = (socket.socket.connect, socket.create_connection, socket.getaddrinfo)
    with deny_network():
        with pytest.raises(NetworkDenied):
            socket.create_connection(("192.0.2.1", 443))
        with pytest.raises(NetworkDenied):
            socket.getaddrinfo("example.org", 443)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(NetworkDenied):
                s.connect(("192.0.2.1", 443))
        finally:
            s.close()
    assert (socket.socket.connect, socket.create_connection, socket.getaddrinfo) == before


def test_deny_network_restores_after_an_exception() -> None:
    before = socket.getaddrinfo
    with pytest.raises(RuntimeError), deny_network():
        raise RuntimeError("boom")
    assert socket.getaddrinfo is before


def test_llm_allowed() -> None:
    assert llm_allowed(DocumentClass.STUDENT, {"docintel.blind_read": True}) is False
    assert llm_allowed(DocumentClass.PUBLIC, {}) is False
    assert llm_allowed(DocumentClass.PUBLIC, {"docintel.blind_read": True}) is True
