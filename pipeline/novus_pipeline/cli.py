"""`python -m novus_pipeline ...` (plan 4.12's CLI, the parts built so far).

    policy check <url>                    host policy, matched entry and reason
    fetch <url> [--kind K]                fetch one URL locally (no upload) and summarize
    normalize <file> [--show]             normalize a saved HTML file
    classify <baseline.html> <current.html>
    validate <page.html> <proposal.json> --url U [--fetched YYYY-MM-DD] [--cycle-key K]
    extract <page.html> --url U           run extract.page.v1 locally (needs GEMINI_API_KEY)
    import-list <README.md> [--listings listings.json] [--csv out.csv]
    drain [--kinds fetch,llm] [--max N]   lease and run jobs (needs NOVUS_INTERNAL_* settings)
    llm status                            whether a Gemini key and model are configured

Output never includes secrets. Commands that only read local files make no network calls.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from .policy import DEFAULT_POLICY


def _print(data: Any) -> None:
    print(json.dumps(data, indent=2, default=str, ensure_ascii=False))


def _cmd_policy(args: argparse.Namespace) -> int:
    d = DEFAULT_POLICY.resolve(args.url)
    _print({"policy": d.policy, "entry": d.entry, "reason": d.reason, "copy": d.copy, "fetchable": d.fetchable})
    return 0


def _cmd_fetch(args: argparse.Namespace) -> int:
    from .config import PipelineConfig
    from .fetcher import FetchRequest, Fetcher
    from .netguard import build_client

    cfg = PipelineConfig.from_env()
    with build_client(cfg.user_agent, cfg.from_address) as client:
        check = Fetcher(client).fetch(FetchRequest(args.url, args.kind))
    out = check.summary()
    if check.body and "html" in check.content_type.lower():
        from .normalize import normalize_html

        doc = normalize_html(check.body, check.content_type)
        out["title"] = doc.title
        out["keyWindows"] = list(doc.key_windows)[:10]
    _print(out)
    return 0 if check.outcome in ("ok", "not_modified") else 2


def _read_doc(path: str) -> Any:
    from .normalize import normalize_html

    return normalize_html(Path(path).read_bytes(), "text/html")


def _cmd_normalize(args: argparse.Namespace) -> int:
    doc = _read_doc(args.file)
    out: dict[str, Any] = {
        "title": doc.title,
        "normalizerVersion": doc.normalizer_version,
        "mainTextSha256": doc.main_text_sha256,
        "watchTokensSha256": doc.watch_tokens_sha256,
        "keyWindows": list(doc.key_windows),
        "hiddenChars": len(doc.hidden_text),
    }
    if args.show:
        out["canonical"] = doc.canonical_text
    _print(out)
    return 0


def _cmd_classify(args: argparse.Namespace) -> int:
    from .detect import SnapshotFacts, classify_change
    from .textnorm import sha256_hex

    base_raw, cur_raw = Path(args.baseline).read_bytes(), Path(args.current).read_bytes()
    base, cur = _read_doc(args.baseline), _read_doc(args.current)
    change = classify_change(
        SnapshotFacts(sha256_hex(base_raw), base.main_text_sha256, base.watch_tokens_sha256),
        SnapshotFacts(sha256_hex(cur_raw), cur.main_text_sha256, cur.watch_tokens_sha256),
        base,
        cur,
    )
    _print({"class": change.cls.value, "tokensChanged": change.tokens_changed, "removed": change.diff.removed, "added": change.diff.added})
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    from .evidence import EvidenceText
    from .rules import extract_rules
    from .validators import CycleContext, validate_extraction

    doc = _read_doc(args.page)
    fetched = date.fromisoformat(args.fetched) if args.fetched else datetime.now(UTC).date()
    proposal = json.loads(Path(args.proposal).read_text(encoding="utf-8"))
    report = validate_extraction(
        proposal, EvidenceText.from_doc(doc), CycleContext(fetched, args.url, args.cycle_key), extract_rules(doc, fetched)
    )
    _print(report.summary())
    return 1 if report.blocked else 0


def _cmd_extract(args: argparse.Namespace) -> int:
    from novus_llm import Gateway

    from .extract import SnapshotContext, extract_page
    from .validators import CycleContext

    gateway = Gateway.from_env()
    if not gateway.available:
        _print({"status": "unavailable", "reason": "GEMINI_API_KEY is not set"})
        return 2
    doc = _read_doc(args.page)
    now = datetime.now(UTC)
    snap = SnapshotContext("00000000-0000-4000-8000-000000000000", args.url, "allowed", True, now)
    outcome = extract_page(gateway, doc, snap, CycleContext(now.date(), args.url, args.cycle_key))
    out: dict[str, Any] = {"status": outcome.status, "reason": outcome.reason_code}
    if outcome.ingest:
        out["proposal"] = outcome.ingest.payload.model_dump()
        out["validation"] = outcome.report.summary() if outcome.report else None
        out["costUsd"] = outcome.llm.cost_usd if outcome.llm else None
    _print(out)
    return 0


def _cmd_import_list(args: argparse.Namespace) -> int:
    from .listimport import load_listings, parse_readme, to_csv

    listings = load_listings(args.listings) if args.listings else []
    rows = parse_readme(Path(args.readme).read_text(encoding="utf-8"), listings)
    if args.csv:
        Path(args.csv).write_text(to_csv(rows), encoding="utf-8")
    _print({"rows": len(rows), "outOfScope": sum(r.out_of_scope for r in rows), "listingsMatched": sum(r.key_kind == "listings_id" for r in rows)})
    return 0


def _cmd_drain(args: argparse.Namespace) -> int:
    from .config import PipelineConfig
    from .fetcher import Fetcher
    from .internal_client import InternalApi
    from .jobs import PipelineDeps, drain
    from .netguard import build_client

    cfg = PipelineConfig.from_env()
    if not cfg.internal_configured:
        print("NOVUS_INTERNAL_BASE_URL, NOVUS_INTERNAL_KEY_ID and NOVUS_INTERNAL_KEY_SECRET are required", file=sys.stderr)
        return 2
    gateway = None
    kinds = [k for k in args.kinds.split(",") if k]
    if "llm" in kinds:
        from novus_llm import Gateway

        gateway = Gateway.from_env()
    api = InternalApi.from_config(cfg)
    if gateway is not None:
        gateway.recorder = api.record_llm_call
    with build_client(cfg.user_agent, cfg.from_address) as client:
        # The catch-up watchdog runs only with a clock key; the drain key may not call it.
        deps = PipelineDeps(api, Fetcher(client), gateway=gateway, clock_api=InternalApi.clock_from_config(cfg))
        stats = drain(deps, kinds, cfg.worker_name, max_jobs=args.max)
    _print(stats.__dict__)
    return 0


def _cmd_llm(args: argparse.Namespace) -> int:  # noqa: ARG001
    from novus_llm import LlmSettings

    s = LlmSettings.from_env()
    _print({"keyConfigured": bool(s.api_key), "model": s.model, "environment": s.environment, "monthlyCapUsd": s.monthly_cap_usd, "killed": sorted(s.kill)})
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="novus-pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)
    pol = sub.add_parser("policy")
    pol_sub = pol.add_subparsers(dest="policy_cmd", required=True)
    chk = pol_sub.add_parser("check")
    chk.add_argument("url")
    chk.set_defaults(fn=_cmd_policy)
    f = sub.add_parser("fetch")
    f.add_argument("url")
    f.add_argument("--kind", default="official_page")
    f.set_defaults(fn=_cmd_fetch)
    n = sub.add_parser("normalize")
    n.add_argument("file")
    n.add_argument("--show", action="store_true")
    n.set_defaults(fn=_cmd_normalize)
    c = sub.add_parser("classify")
    c.add_argument("baseline")
    c.add_argument("current")
    c.set_defaults(fn=_cmd_classify)
    v = sub.add_parser("validate")
    v.add_argument("page")
    v.add_argument("proposal")
    v.add_argument("--url", required=True)
    v.add_argument("--fetched")
    v.add_argument("--cycle-key")
    v.set_defaults(fn=_cmd_validate)
    e = sub.add_parser("extract")
    e.add_argument("page")
    e.add_argument("--url", required=True)
    e.add_argument("--cycle-key")
    e.set_defaults(fn=_cmd_extract)
    il = sub.add_parser("import-list")
    il.add_argument("readme")
    il.add_argument("--listings")
    il.add_argument("--csv")
    il.set_defaults(fn=_cmd_import_list)
    d = sub.add_parser("drain")
    d.add_argument("--kinds", default="fetch")
    d.add_argument("--max", type=int, default=5)
    d.set_defaults(fn=_cmd_drain)
    llm = sub.add_parser("llm")
    llm.add_argument("action", choices=["status"])
    llm.set_defaults(fn=_cmd_llm)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result: int = args.fn(args)
    return result
