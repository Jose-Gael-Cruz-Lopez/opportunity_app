"""HMAC-signed client for the Worker's `/internal/v1/*` endpoints (plan 02 2.3.14, plan 4.12).

The pipeline holds no D1 or R2 credentials: it leases jobs and posts results here, and the Worker
validates and writes.

Signature (the server's verifier must build the same string):

    canonical = "\\n".join([
        "NOVUS-HMAC-SHA256",
        METHOD,                      # upper case
        path_and_query,              # e.g. /internal/v1/jobs/lease
        timestamp,                   # unix seconds, decimal; accepted within 60 s
        nonce,                       # 32 hex chars, single use (D1 insert in the write batch)
        body_sha256_hex,             # SHA-256 of the exact body bytes ("" body hashes too)
        key_id,
    ])
    signature = hex(HMAC-SHA256(secret_for(key_id), canonical))

Headers: x-novus-key-id, x-novus-timestamp, x-novus-nonce, x-novus-signature (shared
HMAC_HEADERS), x-novus-content-sha256 (the body hash, so a raw upload can be checked against its
content address), Idempotency-Key on every POST/PUT, and Cloudflare Access service-token headers
when configured. Retries reuse the Idempotency-Key with a fresh nonce and timestamp.

Errors never include response bodies or request content in their message.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from collections.abc import Callable
from typing import Any

import httpx
from pydantic import BaseModel

from .config import PipelineConfig
from .models import (
    CreateReviewTaskInput,
    ExtractionIngest,
    Heartbeat,
    Job,
    JobComplete,
    JobFail,
    JobLeaseRequest,
    JobLeaseResponse,
    SnapshotIngest,
    SnapshotIngestResult,
    SnapshotMeta,
    to_wire,
)

SCHEME = "NOVUS-HMAC-SHA256"
HEADER_KEY_ID = "x-novus-key-id"
HEADER_TIMESTAMP = "x-novus-timestamp"
HEADER_NONCE = "x-novus-nonce"
HEADER_SIGNATURE = "x-novus-signature"
HEADER_CONTENT_SHA = "x-novus-content-sha256"
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class InternalApiError(Exception):
    def __init__(self, status: int, code: str | None, path: str) -> None:
        super().__init__(f"internal API {path} answered {status}" + (f" ({code})" if code else ""))
        self.status = status
        self.code = code
        self.path = path

    @property
    def retryable(self) -> bool:
        return self.status in RETRY_STATUSES


def canonical_string(method: str, path: str, timestamp: str, nonce: str, body_sha256: str, key_id: str) -> str:
    return "\n".join([SCHEME, method.upper(), path, timestamp, nonce, body_sha256, key_id])


def sign(secret: str, method: str, path: str, timestamp: str, nonce: str, body: bytes, key_id: str) -> dict[str, str]:
    body_sha = hashlib.sha256(body).hexdigest()
    mac = hmac.new(secret.encode("utf-8"), canonical_string(method, path, timestamp, nonce, body_sha, key_id).encode("utf-8"), hashlib.sha256)
    return {
        HEADER_KEY_ID: key_id,
        HEADER_TIMESTAMP: timestamp,
        HEADER_NONCE: nonce,
        HEADER_SIGNATURE: mac.hexdigest(),
        HEADER_CONTENT_SHA: body_sha,
    }


def _json_bytes(body: BaseModel | dict[str, Any] | None) -> bytes:
    import json

    if body is None:
        return b""
    data = to_wire(body) if isinstance(body, BaseModel) else body
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class InternalApi:
    def __init__(
        self,
        base_url: str,
        key_id: str,
        secret: str,
        *,
        client: httpx.Client | None = None,
        access_client_id: str | None = None,
        access_client_secret: str | None = None,
        clock: Callable[[], float] = time.time,
        nonce: Callable[[], str] = lambda: secrets.token_hex(16),
        sleep: Callable[[float], None] = time.sleep,
        attempts: int = 3,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._key_id = key_id
        self._secret = secret
        self._client = client or httpx.Client(timeout=30.0, trust_env=False)
        self._access = (access_client_id, access_client_secret) if access_client_id and access_client_secret else None
        self._clock = clock
        self._nonce = nonce
        self._sleep = sleep
        self._attempts = attempts

    @classmethod
    def from_config(cls, cfg: PipelineConfig, **kw: Any) -> InternalApi:
        if not cfg.internal_configured:
            raise RuntimeError("NOVUS_INTERNAL_BASE_URL, NOVUS_INTERNAL_KEY_ID and NOVUS_INTERNAL_KEY_SECRET are required")
        assert cfg.internal_base_url and cfg.internal_key_id and cfg.internal_key_secret
        return cls(
            cfg.internal_base_url,
            cfg.internal_key_id,
            cfg.internal_key_secret,
            access_client_id=cfg.access_client_id,
            access_client_secret=cfg.access_client_secret,
            **kw,
        )

    @classmethod
    def clock_from_config(cls, cfg: PipelineConfig, **kw: Any) -> InternalApi | None:
        """A client signed with the `clock` key (tickCatchUp only), or None when unset."""
        if not cfg.clock_configured:
            return None
        assert cfg.internal_base_url and cfg.clock_key_id and cfg.clock_key_secret
        return cls(
            cfg.internal_base_url,
            cfg.clock_key_id,
            cfg.clock_key_secret,
            access_client_id=cfg.access_client_id,
            access_client_secret=cfg.access_client_secret,
            **kw,
        )

    # -- transport ---------------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes = b"",
        content_type: str = "application/json",
        idempotency_key: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        last: InternalApiError | None = None
        for attempt in range(self._attempts):
            headers = sign(self._secret, method, path, str(int(self._clock())), self._nonce(), body, self._key_id)
            if body or method in ("POST", "PUT"):
                headers["content-type"] = content_type
            if idempotency_key:
                headers["idempotency-key"] = idempotency_key
            if self._access:
                headers["cf-access-client-id"], headers["cf-access-client-secret"] = self._access
            headers.update(extra_headers or {})
            try:
                resp = self._client.request(method, self.base_url + path, content=body, headers=headers)
            except httpx.HTTPError:
                last = InternalApiError(0, "network_error", path)
            else:
                if resp.status_code < 400:
                    return resp
                code = None
                if "json" in resp.headers.get("content-type", ""):
                    try:
                        code = str(resp.json().get("code") or "") or None
                    except ValueError:
                        code = None
                last = InternalApiError(resp.status_code, code, path)
                if resp.status_code not in RETRY_STATUSES:
                    raise last
            if attempt + 1 < self._attempts:
                self._sleep(2.0 * (2**attempt))
        assert last is not None
        raise last

    def post(self, path: str, body: BaseModel | dict[str, Any] | None, *, idempotency_key: str | None = None) -> Any:
        resp = self.request("POST", path, body=_json_bytes(body), idempotency_key=idempotency_key or secrets.token_hex(16))
        return resp.json() if resp.content else None

    def get(self, path: str) -> Any:
        return self.request("GET", path).json()

    # -- jobs ----------------------------------------------------------------------------------

    def lease_jobs(self, kinds: list[str], owner: str, *, max_jobs: int = 5, lease_seconds: int = 600) -> list[Job]:
        req = JobLeaseRequest(kinds=kinds, owner=owner, max=max_jobs, lease_seconds=lease_seconds)  # type: ignore[arg-type]
        data = self.post("/internal/v1/jobs/lease", req, idempotency_key=f"lease:{owner}:{int(self._clock())}")
        return JobLeaseResponse.model_validate(data).jobs

    def complete_job(self, job_id: str, owner: str, result: dict[str, Any]) -> None:
        self.post(f"/internal/v1/jobs/{job_id}/complete", JobComplete(owner=owner, result=result), idempotency_key=f"complete:{job_id}")

    def fail_job(self, job_id: str, owner: str, error_class: str, disposition: str) -> None:
        body = JobFail(owner=owner, error_class=error_class[:200], disposition=disposition)  # type: ignore[arg-type]
        self.post(f"/internal/v1/jobs/{job_id}/fail", body, idempotency_key=f"fail:{job_id}:{int(self._clock())}")

    def tick_catch_up(self) -> None:
        self.post("/internal/v1/tick/catch-up", {}, idempotency_key=f"catchup:{int(self._clock()) // 600}")

    def heartbeat(self, hb: Heartbeat) -> None:
        self.post("/internal/v1/heartbeats", hb, idempotency_key=f"hb:{hb.worker}:{hb.at}")

    # -- snapshots and extractions -------------------------------------------------------------

    def put_raw(self, sha256: str, body: bytes, url_chain: list[str], content_type: str) -> None:
        """Large objects: the raw bytes as the whole body, addressed by their SHA-256.

        Route `PUT /internal/v1/snapshots/raw/:sha256` is in plan 4.12 but not yet in the shared
        route map; small Snapshots travel inline instead (see `ingest_snapshot`).
        """
        if hashlib.sha256(body).hexdigest() != sha256:
            raise ValueError("content address mismatch")
        self.request(
            "PUT",
            f"/internal/v1/snapshots/raw/{sha256}",
            body=body,
            content_type=content_type or "application/octet-stream",
            idempotency_key=f"raw:{sha256}",
            extra_headers={"x-novus-url-chain": " ".join(url_chain)},
        )

    def ingest_snapshot(self, snap: SnapshotIngest) -> SnapshotIngestResult:
        data = self.post("/internal/v1/snapshots", snap, idempotency_key=f"snapshot:{snap.raw_sha256}:{snap.normalizer_version}:{snap.source_id}")
        return SnapshotIngestResult.model_validate(data)

    def get_snapshot(self, snapshot_id: str) -> SnapshotMeta:
        """Snapshot metadata (plan 4.12 baseline reads; not yet in the route map)."""
        return SnapshotMeta.model_validate(self.get(f"/internal/v1/snapshots/{snapshot_id}"))

    def get_raw(self, sha256: str) -> bytes:
        """Raw Snapshot bytes by content address, re-normalized locally so both sides of a
        comparison use the same normalizer version and volatile masks."""
        body = self.request("GET", f"/internal/v1/snapshots/raw/{sha256}").content
        if hashlib.sha256(body).hexdigest() != sha256:
            raise InternalApiError(502, "content_address_mismatch", "/internal/v1/snapshots/raw")
        return body

    def ingest_extraction(self, ext: ExtractionIngest) -> Any:
        return self.post("/internal/v1/extractions", ext, idempotency_key=f"extraction:{ext.snapshot_id}:{ext.route_id}:{ext.prompt_version}")

    def create_review_task(self, task: CreateReviewTaskInput, *, dedupe: str) -> Any:
        return self.post("/internal/v1/review-tasks", task, idempotency_key=f"task:{dedupe}")

    def record_llm_call(self, record: dict[str, Any]) -> None:
        """One row per attempt (novus_llm.LlmCallRecord wire form): counts and ids, never text.

        Each attempt's record differs (tokens, latency, request id), so its body hash is a stable
        idempotency key across this client's retries."""
        digest = hashlib.sha256(_json_bytes(record)).hexdigest()[:32]
        self.post("/internal/v1/llm-calls", record, idempotency_key=f"llm-call:{digest}")

    def upsert_source(self, body: dict[str, Any], *, idempotency_key: str) -> Any:
        """`POST /internal/v1/sources/upsert` (plan 4.12; not yet in the route map)."""
        return self.post("/internal/v1/sources/upsert", body, idempotency_key=idempotency_key)


def encode_inline(body: bytes) -> str:
    return base64.b64encode(body).decode("ascii")
