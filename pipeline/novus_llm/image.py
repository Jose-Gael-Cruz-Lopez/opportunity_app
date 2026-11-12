"""Adapter that gives DocIntel its `StructuredImageLlm` (pipeline/docintel/adjudicate.py).

DocIntel decides whether a crop may reach a model at all (`isolation.llm_allowed`); this adapter
only routes the call through the gateway, so the same kill switch, budget, refusal handling and
call records apply. It returns None on any non-ok outcome, as the Protocol requires.
"""

from __future__ import annotations

import hashlib
from typing import TypeVar

from pydantic import BaseModel

from .gateway import Gateway
from .types import ImagePart, LLMRequest, SubjectRef

M = TypeVar("M", bound=BaseModel)


class GatewayImageLlm:
    def __init__(self, gateway: Gateway) -> None:
        self._gateway = gateway
        self.model_id = gateway.settings.model

    def extract_from_image(self, *, route: str, image_png: bytes, instruction: str, schema: type[M]) -> M | None:
        crop_id = hashlib.sha256(image_png).hexdigest()[:32]
        req = LLMRequest(
            route_id=route,
            subject=SubjectRef(type="document_crop", id=crop_id),
            images=(ImagePart(mime_type="image/png", data=image_png),),
            instruction=instruction,
            idempotency_key=f"llm:{route}:{crop_id}",
        )
        result = self._gateway.run(req, schema)
        return result.parsed if result.ok else None
