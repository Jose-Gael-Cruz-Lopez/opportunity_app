# novus_eligibility

The server-safe eligibility engine for the Python pipeline: a port of `shared/eligibility`
(TypeScript), used for pipeline-side checks and as the Python runtime of the eligibility release
gate. It answers exactly what the Worker answers for the same rule set, profile, date and context.

```python
from novus_eligibility import evaluate_eligibility

result = evaluate_eligibility(rule_set, {"classYear": "second_year"}, "2027-01-15", context)
result["verdict"]   # "met" | "not_met" | "unknown"
result["status"]    # "eligible" | "conditional" | "unknown" | "not_eligible"
```

## Privacy

There is no parameter for SensitiveAnswers or attestation answers, and a profile key that names a
sensitive field (`citizenship`, `pell`, `financialNeed`, `firstGeneration`, `identity.*`) raises
`SensitiveInputRejectedError`. Sensitive rules come back `unknown` (`SENSITIVE_ON_DEVICE`) and
attestations `unknown` (`ATTESTATION_ON_DEVICE`), to be checked on the student's device. The golden
loader copies only the server-safe keys of each case; `shared/eligibility/privacy-boundary.test.ts`
fails if pipeline code ever reads a case's device answers.

## Files

| File | Port of |
| --- | --- |
| `values.py` | `kleene.ts`, `abstract.ts` (JSON values keep JavaScript's types: `True` is not `1`) |
| `logic.py` | `logic.ts` (tri-state JsonLogic) and `inspectJsonLogic` |
| `standing.py` | `shared/time` dates and terms, `standing.ts` |
| `fields.py` | `fields.ts`, server half |
| `evaluate.py` | `evaluate.ts`, `reasons.ts` |
| `hashing.py` | `hash.ts`, `computeRuleSetHash` |
| `golden.py`, `__main__.py` | the golden runner (`python -m novus_eligibility golden`) |
| `data/catalogue.json` | generated: field catalogue, class years, GPA bands, CIP series, reason copy |
| `data/node-results.json` | generated: the Node result for every golden case (sample data) |

The two data files are generated from `shared/` by `infra/eligibility/snapshots.ts`; never edit
them by hand. After changing the engine, catalogue, copy or golden files:

```bash
UPDATE_GOLDEN=1 npx vitest run --config infra/vitest.config.ts infra/eligibility
```

## Tests and the gate

```bash
pipeline/.venv/bin/python -m pytest pipeline/tests/test_eligibility_golden.py
cd pipeline && .venv/bin/python -m novus_eligibility golden    # exit 1 on any failure
npx tsx infra/scripts/release-gates.ts                         # node, workerd and python
```

The runner checks rule-set hashes, labelled cases that list `python`, redacted twins of
device-only cases, full equality with the Node results, monotonicity (forgetting an answer never
flips met and not_met) and rule-order independence.

Known limit: numbers print like JavaScript only in the range rule sets use (integers and short
decimals); exponent formats (`1e21`, `1e-7`) differ and never occur in rule sets (lint keeps
numbers to four decimals).
