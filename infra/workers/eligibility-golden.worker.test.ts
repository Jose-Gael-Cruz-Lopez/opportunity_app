import { describe, expect, it } from "vitest";
import cases from "../../shared/eligibility/golden/cases.json";
import ruleSets from "../../shared/eligibility/golden/rule-sets.json";
import nodeResults from "../../pipeline/novus_eligibility/data/node-results.json";
import { loadGoldenFiles } from "../eligibility/golden-runner";
import { eligibilityReleaseGate } from "../eligibility/release-gate";

/**
 * The eligibility golden cases inside workerd (plan 06 S06-006, 13 parity): the same JSON the Node
 * runner, the browser and the Python pipeline read. Every case's whole result must equal the Node
 * snapshot (pipeline/novus_eligibility/data/node-results.json, kept fresh by infra/eligibility),
 * so Node and workerd agree exactly. The boundary-profile gate runs here too, since the release
 * build that calls it runs in the Worker.
 */

describe("eligibility golden cases in workerd", () => {
  it("runs in the Workers runtime", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("match their labels, their invariants and the Node snapshot exactly", () => {
    const loaded = loadGoldenFiles({ cases, ruleSets });
    const targets = [...loaded.ruleSets.entries()].map(([label, ruleSet]) => ({ ruleSet, label }));
    const gate = eligibilityReleaseGate({
      golden: { cases, ruleSets, snapshot: nodeResults.results as Record<string, unknown> },
      targets,
      asOf: "2027-01-15",
      runtime: "workerd",
    });
    expect(gate.reasons).toEqual([]);
    expect(gate.golden.runtime).toBe("workerd");
    expect(gate.golden.expectationsChecked).toBeGreaterThanOrEqual(40);
    expect(gate.golden.expectationsChecked + gate.golden.twinsChecked).toBe(gate.golden.cases);
    expect(gate.boundary.profiles).toBeGreaterThan(100);
  });
});
