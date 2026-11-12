"""Host policy: which hosts the pipeline may request automatically (plan 4.3).

The versioned seed of record is `shared/policy/hosts.yaml`, read by this gate, the Worker and CI.
Until that file exists (and while PyYAML is not a pipeline dependency) the same seed is held
here; `load_policy_file` accepts a JSON rendering of the YAML so both stay in step.

Matching: a host matches an entry when it equals it or ends with "." + entry; the longest match
wins; an `exact` entry matches only itself; link-only entries may be path patterns; `smapply.*`
matches that label under any public suffix. Policies govern automated requests and evidence,
never links: a verified application URL may point anywhere.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

HostPolicyName = Literal["allowed", "api_only", "manual_only", "link_only", "never"]
FETCHABLE: frozenset[str] = frozenset({"allowed", "api_only"})

# A small public-suffix subset for the `label.*` wildcard and the registrable-domain bound. The
# full Public Suffix List (tldextract with its bundled snapshot) is requested as a dependency.
MULTI_LABEL_SUFFIXES = frozenset(
    {"co.uk", "ac.uk", "org.uk", "gov.uk", "com.au", "edu.au", "org.au", "co.nz", "ac.nz", "co.jp",
     "ac.jp", "com.br", "co.za", "ac.za", "co.in", "ac.in", "edu.sg", "com.sg", "gc.ca", "qc.ca"}
)  # fmt: skip


@dataclass(frozen=True)
class PolicyEntry:
    pattern: str  # host, "label.*" wildcard, or host/path* for link-only forms
    policy: HostPolicyName
    exact: bool = False
    copy: Literal["none", "quote"] = "quote"
    note: str = ""


def _e(pattern: str, policy: HostPolicyName, **kw: object) -> PolicyEntry:
    return PolicyEntry(pattern, policy, **kw)  # type: ignore[arg-type]


SEED: tuple[PolicyEntry, ...] = (
    *(_e(h, "never", note="terms forbid automated access")
      for h in ("linkedin.com", "lnkd.in", "indeed.com", "joinhandshake.com", "reddit.com", "x.com",
                "twitter.com", "t.co", "glassdoor.com")),
    *(_e(h, "manual_only", copy="none", note="record facts by hand; store no copied text")
      for h in ("smapply.*", "submittable.com", "scholarshipamerica.org", "mykaleidoscope.com",
                "devpost.com", "awardspring.com", "smarterselect.com", "etap.nsf.gov",
                "myworkdayjobs.com", "myworkdaysite.com", "saiapply.org", "grantinterface.com",
                "awardsplatform.com", "applyists.net")),
    *(_e(h, "link_only", copy="none", note="application form: link out, never fetch or cite")
      for h in ("docs.google.com/forms/*", "forms.gle", "forms.office.com", "qualtrics.com", "tfaforms.net")),
    *(_e(h, "api_only", note="documented API paths only")
      for h in ("boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com", "api.smartrecruiters.com",
                "api.nsf.gov", "data.usajobs.gov")),
)  # fmt: skip


@dataclass(frozen=True)
class PolicyDecision:
    policy: HostPolicyName
    entry: str | None
    reason: str
    copy: Literal["none", "quote"] = "quote"

    @property
    def fetchable(self) -> bool:
        return self.policy in FETCHABLE


def normalize_host(host: str) -> str:
    """Lowercase, no trailing dot, IDNA (punycode) form so lookalike Unicode cannot slip by."""
    host = host.strip().rstrip(".").lower()
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        return host


def _wildcard_matches(label: str, host: str) -> bool:
    parts = host.split(".")
    for i, p in enumerate(parts):
        if p == label:
            suffix = ".".join(parts[i + 1 :])
            if suffix and ("." not in suffix or suffix in MULTI_LABEL_SUFFIXES):
                return True
    return False


def _host_matches(entry: PolicyEntry, host: str) -> bool:
    pattern = entry.pattern.split("/", 1)[0]
    if pattern.endswith(".*"):
        return _wildcard_matches(pattern[:-2], host)
    if entry.exact:
        return host == pattern
    return host == pattern or host.endswith("." + pattern)


def _path_matches(entry: PolicyEntry, path: str) -> bool:
    if "/" not in entry.pattern:
        return True
    want = "/" + entry.pattern.split("/", 1)[1]
    if want.endswith("*"):
        return path.startswith(want[:-1])
    return path == want


class HostPolicy:
    def __init__(self, entries: Iterable[PolicyEntry] = SEED) -> None:
        self.entries = tuple(entries)

    def resolve(self, url: str) -> PolicyDecision:
        parts = urlsplit(url)
        host = normalize_host(parts.hostname or "")
        if not host:
            return PolicyDecision("never", None, "no_host")
        path = parts.path or "/"
        matches = [e for e in self.entries if _host_matches(e, host) and _path_matches(e, path)]
        if not matches:
            return PolicyDecision("allowed", None, "default")
        # An exact entry first, then the longest pattern (path patterns are longer, so win).
        best = max(matches, key=lambda e: (e.exact, len(e.pattern)))
        return PolicyDecision(best.policy, best.pattern, "seed", best.copy)


def load_policy_file(path: str | Path) -> HostPolicy:
    """Load `{"entries": [{"pattern", "policy", "exact"?, "copy"?}]}` (a JSON form of hosts.yaml)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = []
    for row in data.get("entries", []):
        policy = row["policy"]
        if policy not in ("allowed", "api_only", "manual_only", "link_only", "never"):
            raise ValueError(f"unknown policy {policy!r}")
        if not re.fullmatch(r"[a-z0-9.*-]+(?:/[\w./*-]*)?", row["pattern"]):
            raise ValueError(f"bad pattern {row['pattern']!r}")
        entries.append(PolicyEntry(row["pattern"], policy, bool(row.get("exact", False)), row.get("copy", "quote")))
    return HostPolicy(entries)


DEFAULT_POLICY = HostPolicy()
