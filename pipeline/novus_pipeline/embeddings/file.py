"""The release vectors file, mirroring shared/matching/embeddings.ts ProgramEmbeddingsFileSchema."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FORMAT = "novus.program-embeddings.v1"

# Mirrors MATCHING_CONFIG.dense (shared/matching/config.ts). The Worker refuses a file whose model
# is not on its list or whose dimensions differ, and search stays lexical.
EMBEDDING_MODELS: dict[str, tuple[int, ...]] = {
    # Matryoshka sizes the model documents; 768 is the release size (judgment, see config.ts).
    "gemini-embedding-001": (768, 1536, 3072),
}
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
DEFAULT_DIMS = 768
DOC_TASK = "RETRIEVAL_DOCUMENT"
QUERY_TASK = "RETRIEVAL_QUERY"

_HASH = r"^[0-9a-f]{64}$"
_B64 = r"^[A-Za-z0-9+/]+={0,2}$"


class ProgramVector(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=64)
    textHash: str = Field(pattern=_HASH)  # noqa: N815 - wire name
    v: str = Field(min_length=4, max_length=20_000, pattern=_B64)


class QueryVector(BaseModel):
    model_config = ConfigDict(extra="forbid")
    textHash: str = Field(pattern=_HASH)  # noqa: N815
    v: str = Field(min_length=4, max_length=20_000, pattern=_B64)


class ProgramEmbeddingsFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["novus.program-embeddings.v1"] = FORMAT
    model: str = Field(min_length=1, max_length=80)
    dims: int = Field(ge=8, le=4096)
    textVersion: int = Field(gt=0)  # noqa: N815
    docTask: str = Field(max_length=40)  # noqa: N815
    queryTask: str = Field(max_length=40)  # noqa: N815
    encoding: Literal["int8-b64"] = "int8-b64"
    generatedAt: str = Field(max_length=40)  # noqa: N815
    sourceRelease: int | None = Field(default=None, ge=0)  # noqa: N815
    programs: list[ProgramVector] = Field(max_length=20_000)
    queries: list[QueryVector] = Field(default_factory=list, max_length=5_000)

    def to_wire(self) -> dict[str, object]:
        return self.model_dump(mode="json")
