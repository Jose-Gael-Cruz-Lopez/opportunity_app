"""Gateway-side guards: public data only, injection-resistant document framing (plan 8.11).

The pipeline never sends student data (rule 3): `student_content` is refused outright here, a
Snapshot reaches a model only when its host is fetchable and did not signal `ai-input=no`, and a
variable whose name looks like a sensitive attribute is refused.
"""

from __future__ import annotations

import re
import secrets

from .types import LLMRequest

# Name stems that would indicate a SensitiveAnswers-like value (mirrors shared SENSITIVE_KEY_STEMS
# in spirit; a variable name, never page text, is checked).
SENSITIVE_STEMS = re.compile(
    r"citizen|immigra|visa|daca|tps|undocument|income|pell|disab|race|racial|ethnic|gender|sex|orientation"
    r"|first_?gen|veteran|military|foster|religio|pregnan|health|ssn|social_security|student|profile|tracker",
    re.I,
)
_ROLE_TAGS = re.compile(r"</?\s*(?:system|assistant|user|model|instructions?|document)[^>]*>|<\|[^|>]{1,40}\|>", re.I)


def block_reason(req: LLMRequest, route_data_class: str) -> str | None:
    """Why this request may not reach a model, or None. Checked before any spend."""
    if req.data_class == "student_content":
        return "student_content_forbidden"
    if req.data_class != route_data_class:
        return "data_class_mismatch"
    if req.subject.type == "snapshot":
        if req.source is None:
            return "missing_source_policy"
        if req.source.host_policy not in ("allowed", "api_only"):
            return "host_policy"
        if not req.source.ai_input_allowed:
            return "ai_input_opt_out"
    for name in req.variables:
        if SENSITIVE_STEMS.search(name):
            return "sensitive_variable"
    return None


def new_boundary() -> str:
    return "NOVUS-DOC-" + secrets.token_hex(12)  # 96 random bits, unguessable by a page author


def frame_document(title: str, text: str, boundary: str) -> str:
    """Untrusted text inside a per-request random boundary, with role-like tags removed."""
    clean = _ROLE_TAGS.sub(" ", text.replace(boundary, " "))
    safe_title = _ROLE_TAGS.sub(" ", title.replace(boundary, " "))[:500]
    return f"<<{boundary} title={safe_title!r}>>\n{clean}\n<<END {boundary}>>"
