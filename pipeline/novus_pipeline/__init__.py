"""novus_pipeline: the Novus acquisition and verification pipeline (plan section 04).

Polite, safe fetching (policy, robots.txt, address guard, limiter); content-hashed Snapshots;
the normalizer's three text channels; the only change detector and reopen rule; the evidence
locator and validators; deterministic risk signals; Curator review-task requests; and the
HMAC client for the Worker's /internal/v1 endpoints. LLM calls go only through `novus_llm`.

The pipeline handles program-side facts only and never reads student data.
"""

__version__ = "0.1.0"
