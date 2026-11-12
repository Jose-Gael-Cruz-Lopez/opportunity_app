"""Release-gate entry point: python -m novus_eligibility golden

Exit 0 when every golden check passes, 1 on any failure, 2 on bad usage. Output names case ids
and rule-set keys only (sample data), never profile values.
"""

from __future__ import annotations

import sys

from .golden import run_golden


def main(argv: list[str]) -> int:
    if argv[:1] != ["golden"]:
        print("usage: python -m novus_eligibility golden", file=sys.stderr)
        return 2
    report = run_golden()
    for failure in report.failures:
        print(f"[eligibility-golden] {failure}", file=sys.stderr)
    print(
        f"python golden: engine {report.engine_version}, {report.cases} cases "
        f"({report.expectations_checked} labelled, {report.twins_checked} redacted twins), "
        f"{report.rule_sets} rule sets, {len(report.failures)} failure(s)"
    )
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
