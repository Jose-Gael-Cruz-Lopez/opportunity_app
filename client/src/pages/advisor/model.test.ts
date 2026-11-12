import { describe, expect, it } from "vitest";
import { CampusDeadlineSubmissionSchema, ProgramListSchema, WorkspaceReportSchema } from "@shared/contracts/advisor";
import { SAMPLE_CAMPUS, sampleLists, sampleProgress, sampleReport } from "./fixtures";
import {
  CampusViewSchema,
  ProgressViewSchema,
  campusBody,
  campusFormErrors,
  emptyCampusForm,
  parseSlugs,
  periodOptions,
  shareUrl,
  suppressionText,
  tableRows,
} from "./model";

describe("advisor model", () => {
  it("builds share links only for lists that have one", () => {
    expect(shareUrl({ visibility: "public", slug: "picks-1", token: null }, "https://novus.example.org/")).toBe("https://novus.example.org/lists/picks-1");
    expect(shareUrl({ visibility: "unlisted", slug: null, token: "abc" }, "https://novus.example.org")).toBe("https://novus.example.org/lists/u/abc");
    expect(shareUrl({ visibility: "public", slug: null, token: null }, "")).toBeNull();
  });

  it("parses program slugs from free text, dropping junk and duplicates", () => {
    expect(parseSlugs("sample-a\nSample-B, sample-a  bad_slug\n\n")).toEqual(["sample-a", "sample-b"]);
  });

  it("offers this month, two earlier months and this quarter", () => {
    const opts = periodOptions(Date.UTC(2026, 0, 15));
    expect(opts.map((o) => o.value)).toEqual(["2026-01", "2025-12", "2025-11", "2026-Q1"]);
  });

  it("explains withheld tables and flags protected cells", () => {
    expect(suppressionText("below_min_total")).toMatch(/Fewer than 5/);
    expect(suppressionText("something_new", 5)).toMatch(/smaller than 5/);
    const rows = tableRows({ period: "2026-11", suppressed: false, total: "15", cells: [{ key: "a", label: "fewer than 5" }, { key: "b", label: "not shown" }, { key: "c", label: "10-19" }] }, { a: "A" });
    expect(rows.map((r) => [r.label, r.protectedValue])).toEqual([["A", true], ["b", true], ["c", false]]);
    expect(tableRows({ period: "2026-11", suppressed: true, reason: "below_min_total" }, {})).toEqual([]);
  });

  it("validates the campus deadline form and builds a contract-valid body", () => {
    const empty = emptyCampusForm("America/Chicago");
    expect(Object.keys(campusFormErrors(empty, "2026-11-11")).sort()).toEqual(["cycleKey", "localDate", "programSlug"]);
    const form = { ...empty, programSlug: "sample-a", cycleKey: "summer-2027", localDate: "2026-12-01", sourceUrl: "https://example.org/office" };
    expect(campusFormErrors(form, "2026-11-11")).toEqual({});
    expect(campusFormErrors({ ...form, localDate: "2026-11-10" }, "2026-11-11").localDate).toMatch(/today or later/);
    expect(campusFormErrors({ ...form, sourceUrl: "http://x" }, "2026-11-11").sourceUrl).toBeDefined();
    expect(CampusDeadlineSubmissionSchema.safeParse(campusBody(form)).success).toBe(true);
  });

  it("keeps sample fixtures valid against the contracts and labelled as sample", () => {
    for (const l of sampleLists(Date.UTC(2026, 10, 11))) {
      expect(ProgramListSchema.safeParse(l).success).toBe(true);
      expect(l.title.startsWith("Sample")).toBe(true);
    }
    expect(WorkspaceReportSchema.safeParse(sampleReport("2026-11")).success).toBe(true);
    expect(ProgressViewSchema.safeParse(sampleProgress("2026-11")).success).toBe(true);
    expect(CampusViewSchema.safeParse(SAMPLE_CAMPUS).success).toBe(true);
    // No fixture carries anything that could name a student.
    const raw = JSON.stringify([sampleLists(0), sampleProgress("2026-11"), SAMPLE_CAMPUS, sampleReport("2026-11")]);
    expect(raw).not.toMatch(/userId|email|displayName|publicId/);
  });
});
