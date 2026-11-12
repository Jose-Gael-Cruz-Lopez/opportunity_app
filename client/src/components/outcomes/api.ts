/**
 * Query hooks for Outcome reports and the public outcome summary. Every call goes through the
 * shell's typed client (lib/api.ts: route map, schema checks, the sensitive-key guard), and
 * sample mode never touches the network: a sample "report" lives only in the query cache.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OutcomeReport, OutcomeReportCreate, OutcomeReportUpdate } from "@shared/contracts/advisor";
import { OutcomeSummarySchema, type OutcomeSummary } from "@shared/readiness/outcomes";
import { api, ApiError } from "@/lib/api";
import { isApiUnavailable, samplesForced } from "@/components/readiness/api-client";

export const OUTCOME_KEYS = {
  mine: ["me", "outcomes"] as const,
  summary: (slug: string) => ["program", slug, "outcomes-summary"] as const,
};

/** The student's own reports (signed in). Signed out or no API: an empty list, never an error banner. */
export function useMyOutcomes(enabled = true) {
  return useQuery({
    queryKey: OUTCOME_KEYS.mine,
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<OutcomeReport[]> => {
      if (samplesForced()) return [];
      try {
        return (await api.call("listOutcomes")).items;
      } catch (err) {
        if (isApiUnavailable(err) || (err instanceof ApiError && err.status === 401)) return [];
        throw err;
      }
    },
  });
}

let sampleCounter = 0;

/** A cache-only report for sample cards: labelled sample, never sent. */
export function sampleReport(body: OutcomeReportCreate, nowIso: string): OutcomeReport {
  sampleCounter += 1;
  return {
    publicId: `SampleReport${String(sampleCounter).padStart(10, "0")}`,
    programCycleId: body.programCycleId,
    tier: "self_reported",
    stages: body.stages,
    decision: body.decision,
    decidedOn: body.decidedOn,
    snapshot: { classYear: null, gpaBand: null, majorFamily: null, institutionType: null, priorFeeder: body.priorFeeder ?? null },
    qualityState: "ok",
    createdAt: nowIso,
  };
}

export function useSaveOutcome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sample: boolean; create?: OutcomeReportCreate; update?: { publicId: string; patch: OutcomeReportUpdate } }): Promise<OutcomeReport> => {
      if (input.sample) {
        const mine = qc.getQueryData<OutcomeReport[]>(OUTCOME_KEYS.mine) ?? [];
        if (input.create) return sampleReport(input.create, new Date().toISOString());
        const current = mine.find((r) => r.publicId === input.update?.publicId);
        if (!current || !input.update) throw new Error("sample report not found");
        const p = input.update.patch;
        return { ...current, ...(p.stages ? { stages: p.stages } : {}), ...(p.decision !== undefined ? { decision: p.decision } : {}), ...(p.decidedOn !== undefined ? { decidedOn: p.decidedOn } : {}) };
      }
      if (input.create) return api.call("createOutcome", { body: input.create });
      if (input.update) return api.call("updateOutcome", { params: { publicId: input.update.publicId }, body: input.update.patch });
      throw new Error("nothing to save");
    },
    onSuccess: (report) => {
      qc.setQueryData<OutcomeReport[]>(OUTCOME_KEYS.mine, (prev = []) => [report, ...prev.filter((r) => r.publicId !== report.publicId)]);
    },
  });
}

/** The public, disclosure-safe summary for a program (aggregate labels only). */
export function useOutcomeSummary(slug: string | undefined) {
  return useQuery({
    queryKey: OUTCOME_KEYS.summary(slug ?? ""),
    enabled: Boolean(slug),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<OutcomeSummary | null> => {
      try {
        const raw = await api.call("outcomeSummary", { params: { slug: slug! } });
        return OutcomeSummarySchema.parse(raw);
      } catch (err) {
        // No API here (dev) or no summary for this program: the panel simply does not show.
        if (isApiUnavailable(err) || (err instanceof ApiError && err.status === 404)) return null;
        throw err;
      }
    },
  });
}
