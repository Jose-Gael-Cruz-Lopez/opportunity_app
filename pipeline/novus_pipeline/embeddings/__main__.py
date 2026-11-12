"""`python -m novus_pipeline.embeddings ...`

    status                                   key, model and whether novus_llm can embed yet
    build --cards client-core.json --out embeddings.json
          [--previous old.json] [--queries labelled.json] [--max-new N]
          [--model gemini-embedding-001] [--dims 768] [--upload]

`--cards` is a published client-core file (public program cards). `--queries` is a JSON list of
team-written labelled queries (strings, or objects with a "query" key): never student queries.
With no key the command prints `unavailable`, writes nothing and exits 0: search stays lexical.
Output never includes secrets or program text, only counts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .build import build_embeddings_file
from .embedder import EmbeddingsUnavailable, embedder_from_env
from .file import DEFAULT_DIMS, DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODELS, ProgramEmbeddingsFile


def _print(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def load_cards(path: Path) -> tuple[list[dict[str, Any]], int | None]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return [c for c in data if isinstance(c, dict)], None
    cards = data.get("cards") if isinstance(data, dict) else None
    if not isinstance(cards, list):
        raise SystemExit("--cards must be a client-core release file or a list of cards")
    release = data.get("release")
    return [c for c in cards if isinstance(c, dict)], release if isinstance(release, int) else None


def load_queries(path: Path | None) -> list[str]:
    if path is None:
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for item in data if isinstance(data, list) else []:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict) and isinstance(item.get("query"), str):
            out.append(item["query"])
    return out


def _cmd_status(args: argparse.Namespace) -> int:
    from novus_llm import Gateway, LlmSettings

    s = LlmSettings.from_env()
    _print(
        {
            "apiKey": "set" if s.api_key else "unset",
            "embeddingModels": sorted(EMBEDDING_MODELS),
            "novusLlmCanEmbed": callable(getattr(Gateway, "embed", None)),
        }
    )
    return 0


def _cmd_build(args: argparse.Namespace, embedder: Any = None) -> int:
    cards, release = load_cards(Path(args.cards))
    previous = ProgramEmbeddingsFile.model_validate_json(Path(args.previous).read_text(encoding="utf-8")) if args.previous else None
    try:
        emb = embedder or embedder_from_env(args.model, args.dims)
        file, stats = build_embeddings_file(
            cards, emb, previous=previous, labelled_queries=load_queries(Path(args.queries) if args.queries else None), source_release=release, max_new=args.max_new
        )
    except EmbeddingsUnavailable as exc:
        _print({"status": "unavailable", "reason": exc.reason, "note": "nothing written; search stays lexical"})
        return 0
    Path(args.out).write_text(json.dumps(file.to_wire(), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    result: dict[str, Any] = {"status": "built", "out": str(args.out), "model": file.model, "dims": file.dims, **vars(stats)}
    if args.upload:
        from ..config import PipelineConfig
        from ..internal_client import InternalApi
        from .upload import upload_embeddings

        upload_embeddings(InternalApi.from_config(PipelineConfig.from_env()), file)
        result["uploaded"] = True
    _print(result)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m novus_pipeline.embeddings")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    b = sub.add_parser("build")
    b.add_argument("--cards", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--previous")
    b.add_argument("--queries")
    b.add_argument("--max-new", type=int, default=None)
    b.add_argument("--model", default=DEFAULT_EMBEDDING_MODEL)
    b.add_argument("--dims", type=int, default=DEFAULT_DIMS)
    b.add_argument("--upload", action="store_true")
    return p


def main(argv: list[str] | None = None, *, embedder: Any = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "status":
        return _cmd_status(args)
    return _cmd_build(args, embedder)


if __name__ == "__main__":
    sys.exit(main())
