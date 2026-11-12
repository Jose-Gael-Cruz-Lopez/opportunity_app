"""Network safety: only public addresses, only http(s) on 80/443, connections pinned to the
validated IP (plan 4.5, "Network safety").

`AddressGuard` resolves a host and refuses any non-global address, unwrapping IPv4 embedded in
IPv6 (mapped, NAT64, 6to4, Teredo). A resolve-then-connect check leaves a DNS-rebinding window,
so `PinnedTransport` closes it: its network backend receives the hostname, resolves once,
validates, and connects to that exact IP, while TLS still uses the hostname for SNI and
certificate checks (httpcore passes `server_hostname` from the request URL, not from the socket).
The private `_pool` of httpx's own transport is never patched.
"""

from __future__ import annotations

import ipaddress
import socket
import typing
from collections.abc import Callable, Iterable, Iterator
from urllib.parse import urlsplit

import httpcore
import httpx

Resolver = Callable[[str, int], list[str]]

ALLOWED_SCHEMES = frozenset({"http", "https"})
ALLOWED_PORTS = frozenset({80, 443})
_EXTRA_BLOCKED = tuple(
    ipaddress.ip_network(n)
    for n in ("0.0.0.0/8", "100.64.0.0/10", "240.0.0.0/4", "169.254.169.254/32", "::/128", "fd00:ec2::254/128")
)
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_SIX_TO_FOUR = ipaddress.ip_network("2002::/16")


class BlockedAddress(Exception):
    """A URL or address the pipeline must never contact. The message carries no URL text."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> list[ipaddress.IPv4Address]:
    out: list[ipaddress.IPv4Address] = []
    if ip.ipv4_mapped is not None:
        out.append(ip.ipv4_mapped)
    if ip.teredo is not None:
        out.extend(ip.teredo)  # (server, client)
    if ip.sixtofour is not None:
        out.append(ip.sixtofour)
    if ip in _NAT64:
        out.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return out


def is_public_address(address: str) -> bool:
    """True only for global unicast addresses, including every IPv4 address embedded in IPv6."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if any(ip in net for net in _EXTRA_BLOCKED if net.version == ip.version):
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded:  # judge an IPv6 wrapper by every IPv4 address it carries
            return all(is_public_address(str(v4)) for v4 in embedded)
    return bool(ip.is_global and not ip.is_multicast)


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


class AddressGuard:
    def __init__(self, resolver: Resolver = system_resolver) -> None:
        self._resolve = resolver

    def check_url(self, url: str) -> None:
        """Scheme and port rules; raises BlockedAddress."""
        parts = urlsplit(url)
        if parts.scheme not in ALLOWED_SCHEMES:
            raise BlockedAddress("scheme")
        if parts.username or parts.password:
            raise BlockedAddress("userinfo")
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError as exc:
            raise BlockedAddress("port") from exc
        if port not in ALLOWED_PORTS:
            raise BlockedAddress("port")
        if not parts.hostname:
            raise BlockedAddress("no_host")

    def resolve_public(self, host: str, port: int) -> list[str]:
        """Every resolved address must be public; one bad answer blocks the host."""
        try:
            literal = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            literal = None
        if literal is not None:
            addresses = [str(literal)]
        else:
            try:
                addresses = self._resolve(host, port)
            except OSError as exc:
                raise BlockedAddress("dns_failure") from exc
        if not addresses:
            raise BlockedAddress("dns_empty")
        if not all(is_public_address(a) for a in addresses):
            raise BlockedAddress("non_public_address")
        return addresses

    def check_host(self, url: str) -> list[str]:
        self.check_url(url)
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return self.resolve_public(parts.hostname or "", port)


class PinnedBackend(httpcore.NetworkBackend):
    """Resolves once, validates, then connects to the validated IP (no second lookup)."""

    def __init__(self, guard: AddressGuard, inner: httpcore.NetworkBackend | None = None) -> None:
        self._guard = guard
        self._inner = inner or httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: typing.Iterable[typing.Any] | None = None,
    ) -> httpcore.NetworkStream:
        if port not in ALLOWED_PORTS:
            raise httpcore.ConnectError("port not allowed")
        try:
            addresses = self._guard.resolve_public(host, port)
        except BlockedAddress as exc:
            raise httpcore.ConnectError(f"blocked: {exc.reason}") from exc
        last: Exception | None = None
        for ip in addresses:
            try:
                return self._inner.connect_tcp(ip, port, timeout, local_address, socket_options)
            except httpcore.ConnectError as exc:
                last = exc
        raise httpcore.ConnectError("connect failed") from last

    def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: typing.Iterable[typing.Any] | None = None) -> httpcore.NetworkStream:  # noqa: ARG002
        raise httpcore.ConnectError("unix sockets are not allowed")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


_EXC_MAP: tuple[tuple[type[Exception], type[httpx.HTTPError]], ...] = (
    (httpcore.ConnectTimeout, httpx.ConnectTimeout),
    (httpcore.ReadTimeout, httpx.ReadTimeout),
    (httpcore.WriteTimeout, httpx.WriteTimeout),
    (httpcore.PoolTimeout, httpx.PoolTimeout),
    (httpcore.ConnectError, httpx.ConnectError),
    (httpcore.ReadError, httpx.ReadError),
    (httpcore.WriteError, httpx.WriteError),
    (httpcore.RemoteProtocolError, httpx.RemoteProtocolError),
    (httpcore.LocalProtocolError, httpx.LocalProtocolError),
    (httpcore.ProtocolError, httpx.ProtocolError),
    (httpcore.UnsupportedProtocol, httpx.UnsupportedProtocol),
    (httpcore.TimeoutException, httpx.TimeoutException),
    (httpcore.NetworkError, httpx.NetworkError),
)


def _map_exc(exc: Exception) -> Exception:
    for src, dst in _EXC_MAP:
        if isinstance(exc, src):
            return dst(str(exc))
    return exc


class _Body(httpx.SyncByteStream):
    def __init__(self, stream: Iterable[bytes]) -> None:
        self._stream = stream

    def __iter__(self) -> Iterator[bytes]:
        try:
            yield from self._stream
        except Exception as exc:  # map httpcore errors the way httpx's own transport does
            mapped = _map_exc(exc)
            if mapped is exc:
                raise
            raise mapped from exc

    def close(self) -> None:
        close = getattr(self._stream, "close", None)
        if close is not None:
            close()


class PinnedTransport(httpx.BaseTransport):
    """An httpx transport over an httpcore pool whose backend pins validated addresses."""

    def __init__(self, guard: AddressGuard | None = None, *, backend: httpcore.NetworkBackend | None = None) -> None:
        self._pool = httpcore.ConnectionPool(
            network_backend=backend or PinnedBackend(guard or AddressGuard()),
            max_connections=4,
            retries=0,
        )

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        assert isinstance(request.stream, httpx.SyncByteStream)
        req = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        try:
            resp = self._pool.handle_request(req)
        except Exception as exc:
            mapped = _map_exc(exc)
            if mapped is exc:
                raise
            raise mapped from exc
        return httpx.Response(
            status_code=resp.status,
            headers=resp.headers,
            stream=_Body(typing.cast(Iterable[bytes], resp.stream)),
            extensions=resp.extensions,
        )

    def close(self) -> None:
        self._pool.close()


def build_client(
    user_agent: str,
    from_address: str,
    *,
    guard: AddressGuard | None = None,
    transport: httpx.BaseTransport | None = None,
    timeout: float = 20.0,
) -> httpx.Client:
    """The only HTTP client the fetcher uses: pinned, no env proxies, no automatic redirects."""
    return httpx.Client(
        transport=transport or PinnedTransport(guard),
        trust_env=False,  # proxy variables cannot divert traffic
        follow_redirects=False,  # every hop is re-checked by the fetcher
        timeout=httpx.Timeout(timeout, connect=10.0),
        headers={"User-Agent": user_agent, "From": from_address, "Accept-Encoding": "gzip, deflate"},
    )
