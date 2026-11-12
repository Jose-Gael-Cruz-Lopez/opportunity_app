import { describe, expect, it } from "vitest";
import { ProgramCardSchema, ProgramCycleSchema, ProgramSchema, RequirementSchema, FORBIDDEN_STUDENT_SCORE_FIELDS } from "@shared/contracts";
import { API_BASE, failureFor, postFirstDoor, postResumeExtract, request } from "./api";
import { applicationDate, bundleFrom, loadCatalog, MIN_LIVE_PROGRAMS } from "./catalog";
import { SAMPLE_COUNT, buildSamplePrograms, prepDaysFor, sampleId } from "./fixtures";

const NOW = new Date("2026-11-11T15:00:00Z");

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { fetcher, calls };
}

describe("api failures", () => {
  it("maps statuses and problem bodies to typed reasons", () => {
    expect(failureFor(401, null)).toEqual({ ok: false, reason: "signed_out" });
    expect(failureFor(422, { code: "unredacted_content", kinds: ["email", 3] })).toEqual({ ok: false, reason: "unredacted", kinds: ["email"] });
    expect(failureFor(400, { code: "consent_required" })).toEqual({ ok: false, reason: "consent_required" });
    expect(failureFor(503, {})).toEqual({ ok: false, reason: "offline" });
    expect(failureFor(400, { code: "validation_failed" })).toEqual({ ok: false, reason: "rejected", status: 400 });
  });

  it("returns offline instead of throwing when the network fails", async () => {
    const { fetcher } = fakeFetch(() => new Error("network"));
    expect(await request("/state", { method: "GET" }, fetcher)).toEqual({ ok: false, reason: "offline" });
  });

  it("sends the redacted text with consent:true and nothing else", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ status: 200, body: { ai: "off" } }));
    const r = await postResumeExtract("Built [removed] in Python", true, fetcher);
    expect(r).toEqual({ ok: true, data: { ai: "off" }, status: 200 });
    expect(calls[0].url).toBe(`${API_BASE}/resume/extract`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ redactedText: "Built [removed] in Python", consent: true });
    expect(calls[0].init?.method).toBe("POST");
  });

  it("posts first-door bodies in the server's shape", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ status: 201, body: {} }));
    await postFirstDoor({ programId: "p", programCycleId: "c", completedStepIds: ["save"], intention: { stepId: "submit", on: "2026-11-12", at: "17:00" }, timeZone: "America/Chicago" }, fetcher);
    expect(Object.keys(JSON.parse(String(calls[0].init?.body))).sort()).toEqual(["completedStepIds", "intention", "programCycleId", "programId", "timeZone"]);
  });
});

describe("sample fixtures", () => {
  const samples = buildSamplePrograms(NOW);

  it("are valid against the shared contracts and labelled sample", () => {
    expect(samples).toHaveLength(SAMPLE_COUNT);
    for (const s of samples) {
      expect(ProgramCardSchema.safeParse(s.card).success).toBe(true);
      expect(ProgramSchema.safeParse(s.program).success).toBe(true);
      expect(ProgramCycleSchema.safeParse(s.cycle).success).toBe(true);
      for (const r of s.requirements) expect(RequirementSchema.safeParse(r).success).toBe(true);
      expect(s.card.isSample && s.program.isSample).toBe(true);
      expect(s.card.name.startsWith("Sample ")).toBe(true);
      expect(new URL(s.card.officialUrl).hostname).toBe("example.org");
    }
  });

  it("keep deadlines in the future relative to now, and stable ids", () => {
    for (const s of samples) {
      const d = applicationDate(s.card);
      if (d) expect(d > "2026-11-11").toBe(true);
    }
    expect(buildSamplePrograms(NOW)[0].card.programId).toBe(samples[0].card.programId);
    expect(sampleId(1, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("compute prepDays as max(lead + effort days)", () => {
    expect(prepDaysFor([{ kind: "essay", label: "e", effortHours: 3 }, { kind: "recommendation", label: "l", quantity: 2, effortHours: 1, leadTimeDays: 21 }])).toBe(23);
  });

  it("carry no student score fields", () => {
    const json = JSON.stringify(samples);
    for (const f of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(json).not.toContain(`"${f}"`);
  });
});

describe("catalog", () => {
  const samples = buildSamplePrograms(NOW);

  it("falls back to samples when the API is unreachable or returns junk", async () => {
    expect((await loadCatalog(NOW, fakeFetch(() => new Error("down")).fetcher)).sample).toBe(true);
    expect((await loadCatalog(NOW, fakeFetch(() => new Error("down")).fetcher)).source).toBe("fixtures");
    expect((await loadCatalog(NOW, fakeFetch(() => ({ status: 200, body: { items: [{ nope: 1 }] } })).fetcher)).sample).toBe(true);
    expect((await loadCatalog(NOW, fakeFetch(() => ({ status: 500 })).fetcher)).bundles).toHaveLength(SAMPLE_COUNT);
  });

  it("joins live cards with their detail when enough are available", async () => {
    const live = samples.slice(0, MIN_LIVE_PROGRAMS + 1).map((s) => ({ ...s, card: { ...s.card, isSample: false } }));
    const { fetcher, calls } = fakeFetch((url) => {
      if (url.startsWith("/api/v1/programs?")) return { status: 200, body: { items: live.map((s) => s.card), page: { nextCursor: null }, release: 1 } };
      const slug = decodeURIComponent(url.split("/").pop()!);
      const s = live.find((x) => x.card.slug === slug)!;
      return {
        status: 200,
        body: {
          program: s.program,
          organization: { id: s.program.organizationId, slug: "org", name: s.card.organizationName, kind: "nonprofit", country: "US", defaultTimeZone: null, websiteUrl: null, isSample: true },
          cycle: s.cycle,
          deadlines: [],
          requirements: s.requirements,
          requirementsChecked: true,
          counts: [],
          stageOdds: [],
          prediction: null,
          ruleSet: null,
          otherCycles: [],
          citation: {
            novusUrl: `https://example.org/novus/${s.card.slug}`,
            officialUrl: s.card.officialUrl,
            basis: "official",
            evidenceUrl: null,
            evidenceExcerpt: null,
            lastVerifiedAt: null,
            verifiedBy: null,
            derivation: null,
            sourceCheckedAt: null,
            verificationState: "unverified",
            freshness: "fresh",
            recordVersion: "1",
            license: "sample",
            termsUrl: "https://example.org/terms",
          },
          release: 1,
        },
      };
    });
    const c = await loadCatalog(NOW, fetcher);
    expect(c.sample).toBe(false);
    expect(c.source).toBe("live");
    expect(c.bundles.map((b) => b.card.slug)).toEqual(live.map((s) => s.card.slug));
    expect(c.bundles[0].requirements).toHaveLength(live[0].requirements.length);
    expect(calls.every((x) => (x.init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("bundles only matching card and detail ids, never sensitive-audience programs", () => {
    const s = samples[0];
    const detail = { program: s.program, cycle: s.cycle, requirements: s.requirements } as unknown as Parameters<typeof bundleFrom>[1];
    expect(bundleFrom(s.card, detail)?.card.programId).toBe(s.card.programId);
    expect(bundleFrom(samples[1].card, detail)).toBeNull();
    const sensitive = { ...detail, program: { ...s.program, sensitiveAudience: true } } as typeof detail;
    expect(bundleFrom(s.card, sensitive)).toBeNull();
  });

  it("reads the national application date and ignores rolling deadlines", () => {
    expect(applicationDate(samples[0].card)).toBe("2026-12-26");
    const rolling = samples.find((s) => s.card.slug === "sample-open-source-starter-sprint")!;
    expect(applicationDate(rolling.card)).toBeNull();
  });
});
