"""Uploads a vectors file to the Worker (route to be registered: POST /internal/v1/embeddings).

The pipeline holds no R2 credentials (plan 4.12): the Worker validates the body with
ProgramEmbeddingsFileSchema and stores it; the next release.build aligns it with the release.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .file import ProgramEmbeddingsFile

UPLOAD_PATH = "/internal/v1/embeddings"


def file_digest(file: ProgramEmbeddingsFile) -> str:
    body = json.dumps(file.to_wire(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def upload_embeddings(api: Any, file: ProgramEmbeddingsFile) -> Any:
    """`api` is novus_pipeline.internal_client.InternalApi. Idempotent on the file's digest."""
    return api.post(UPLOAD_PATH, file.to_wire(), idempotency_key=f"embeddings:{file_digest(file)}")
