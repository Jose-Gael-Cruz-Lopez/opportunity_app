import { describe, expect, it } from "vitest";
import { SAMPLE_READINESS } from "@/components/readiness/fixtures";
import { nextStartBy, readinessSlugFrom } from "./model";

describe("readinessSlugFrom", () => {
  it("prefers a valid ?program= slug and falls back to the report's", () => {
    expect(readinessSlugFrom("?program=sample-coastal-research-scholars", null)).toBe("sample-coastal-research-scholars");
    expect(readinessSlugFrom("program=abc", "from-report")).toBe("abc");
    expect(readinessSlugFrom("?program=Not%20A%20Slug", "from-report")).toBe("from-report");
    expect(readinessSlugFrom("", null)).toBeNull();
  });
});

describe("nextStartBy", () => {
  it("picks the earliest open item", () => {
    expect(nextStartBy(SAMPLE_READINESS)).toEqual({ date: "2027-01-05", label: "Two recommendation letters" });
  });

  it("is null when everything is ready", () => {
    const done = { ...SAMPLE_READINESS, requirements: { ...SAMPLE_READINESS.requirements, items: SAMPLE_READINESS.requirements.items.map((i) => ({ ...i, state: "met" as const })) } };
    expect(nextStartBy(done)).toBeNull();
  });
});
