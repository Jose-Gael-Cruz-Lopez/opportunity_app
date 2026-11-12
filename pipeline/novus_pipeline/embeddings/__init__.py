"""novus_pipeline.embeddings: offline program vectors for Phase 3 hybrid search (plan 6.5).

Public text only: the vectors come from the cards of a published release, through novus_llm (the
only Python path to Gemini). With no key, or before novus_llm exposes `Gateway.embed`, nothing is
built and search stays lexical. See README.md.
"""

from .build import BuildStats, build_embeddings_file
from .codec import cosine, decode_int8, encode_int8
from .embedder import Embedder, EmbeddingError, EmbeddingsUnavailable, HashingEmbedder, NovusLlmEmbedder, embedder_from_env
from .file import DEFAULT_DIMS, DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODELS, FORMAT, ProgramEmbeddingsFile
from .text import TEXT_VERSION, embedding_text, embedding_text_hash, known_item_query_texts, normalize_query_text, query_text_hash, scripted_misspelling
from .upload import UPLOAD_PATH, upload_embeddings

__all__ = [
    "DEFAULT_DIMS",
    "DEFAULT_EMBEDDING_MODEL",
    "EMBEDDING_MODELS",
    "FORMAT",
    "TEXT_VERSION",
    "UPLOAD_PATH",
    "BuildStats",
    "Embedder",
    "EmbeddingError",
    "EmbeddingsUnavailable",
    "HashingEmbedder",
    "NovusLlmEmbedder",
    "ProgramEmbeddingsFile",
    "build_embeddings_file",
    "cosine",
    "decode_int8",
    "embedder_from_env",
    "embedding_text",
    "embedding_text_hash",
    "encode_int8",
    "known_item_query_texts",
    "normalize_query_text",
    "query_text_hash",
    "scripted_misspelling",
    "upload_embeddings",
]
