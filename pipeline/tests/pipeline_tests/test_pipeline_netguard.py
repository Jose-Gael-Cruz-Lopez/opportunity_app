from __future__ import annotations

import httpcore
import httpx
import pytest

from novus_pipeline.netguard import AddressGuard, BlockedAddress, PinnedBackend, PinnedTransport, build_client, is_public_address


@pytest.mark.parametrize(
    ("addr", "public"),
    [
        ("93.184.215.14", True),
        ("2606:4700::1111", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),  # CGNAT
        ("0.0.0.0", False),
        ("240.0.0.1", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("::", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("fd00:ec2::254", False),  # IPv6 metadata endpoint
        ("::ffff:127.0.0.1", False),  # IPv4-mapped
        ("::ffff:169.254.169.254", False),
        ("64:ff9b::a9fe:a9fe", False),  # NAT64 of 169.254.169.254
        ("2002:a9fe:a9fe::1", False),  # 6to4 of 169.254.169.254
        ("2001:0:4136:e378:8000:63bf:80ff:fffe", False),  # Teredo client 127.0.0.1
        ("not-an-ip", False),
    ],
)
def test_address_vectors(addr: str, public: bool) -> None:
    assert is_public_address(addr) is public


def test_scheme_port_and_userinfo_rules() -> None:
    g = AddressGuard(resolver=lambda h, p: ["93.184.215.14"])
    g.check_url("https://example.org/x")
    g.check_url("http://example.org:80/x")
    for bad in ("ftp://example.org/", "https://example.org:8443/", "https://user:pw@example.org/", "gopher://x"):
        with pytest.raises(BlockedAddress):
            g.check_url(bad)


def test_one_private_answer_blocks_the_host() -> None:
    g = AddressGuard(resolver=lambda h, p: ["93.184.215.14", "10.0.0.5"])
    with pytest.raises(BlockedAddress) as exc:
        g.check_host("https://rebind.example.org/")
    assert exc.value.reason == "non_public_address"


def test_ip_literal_hosts_are_checked_without_dns() -> None:
    g = AddressGuard(resolver=lambda h, p: pytest.fail("no DNS for literals"))
    with pytest.raises(BlockedAddress):
        g.check_host("http://169.254.169.254/latest/meta-data")
    with pytest.raises(BlockedAddress):
        g.check_host("http://[::1]/")


class _RecordingBackend(httpcore.NetworkBackend):
    def __init__(self) -> None:
        self.connected: list[tuple[str, int]] = []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[no-untyped-def]
        self.connected.append((host, port))
        raise httpcore.ConnectError("recorded")

    def connect_unix_socket(self, path, timeout=None, socket_options=None):  # type: ignore[no-untyped-def]
        raise AssertionError

    def sleep(self, seconds: float) -> None:
        pass


def test_pinned_backend_refuses_hostnames_resolving_to_loopback_or_metadata() -> None:
    inner = _RecordingBackend()
    for answer in ("127.0.0.1", "169.254.169.254"):
        backend = PinnedBackend(AddressGuard(resolver=lambda h, p, a=answer: [a]), inner)
        with pytest.raises(httpcore.ConnectError, match="blocked"):
            backend.connect_tcp("evil.example.org", 443)
    assert inner.connected == []  # never connected


def test_pinned_backend_connects_to_the_validated_ip_not_the_name() -> None:
    inner = _RecordingBackend()
    backend = PinnedBackend(AddressGuard(resolver=lambda h, p: ["93.184.215.14"]), inner)
    with pytest.raises(httpcore.ConnectError):
        backend.connect_tcp("www.example.org", 443)
    assert inner.connected == [("93.184.215.14", 443)]


def test_transport_maps_connect_errors_and_client_ignores_env_proxies(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    inner = _RecordingBackend()
    transport = PinnedTransport(backend=PinnedBackend(AddressGuard(resolver=lambda h, p: ["127.0.0.1"]), inner))
    client = build_client("NovusBot/1.0 (+https://novus.example/bot)", "crawler@novus.example", transport=transport)
    assert client._trust_env is False  # noqa: SLF001 - asserting configuration only
    with pytest.raises(httpx.ConnectError):
        client.get("https://evil.example.org/")
    assert inner.connected == []
