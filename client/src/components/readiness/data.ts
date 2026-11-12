/**
 * TanStack Query hooks for the Program, Readiness and Tracker screens.
 *
 * Every request goes through the shell's API client (lib/api.ts). Session and tracker share the
 * shell's cache keys and loaders (lib/queries.ts), so tracking a program from Explore shows on
 * the Tracker and the Program page at once; these hooks only reshape the cached `Sourced<T>`
 * into the `{ data, sample }` form the screens use. When no API answers and the data mode allows
 * it, the hooks serve labelled fixtures and mutations change only the in-memory cache.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ROUTES } from "@shared/contracts/routes";
import type { MeSessionResponse, RequirementProgressUpdate, TrackerItem, TrackerItemUpdate } from "@shared/contracts/student";
import type { ProgramCard, ProgramDetail, ReleaseArtifact } from "@shared/contracts/registry";
import type { ReadinessReport } from "@shared/contracts/readiness";
import type { ReadinessExplainRequest, ReadinessExplainResponse } from "@shared/contracts/ai";
import type { RoadmapItemAction } from "@shared/contracts/roadmap";
import { api } from "@/lib/api";
import type { Sourced } from "@/lib/data-source";
import { sampleProgramCards } from "@/lib/fixtures/programs";
import { fetchSession, fetchTracker, queryKeys } from "@/lib/queries";
import { ApiError, fetchReleaseFile, isApiUnavailable, isProblemStatus, loadWithSample, samplesForced, toLoaded, type Loaded } from "./api-client";
import { SAMPLE_CARDS, SAMPLE_PROGRAM_DETAIL, SAMPLE_READINESS } from "./fixtures";
import { fallbackExplanation } from "./explain";

const KEYS = {
  session: queryKeys.session,
  tracker: queryKeys.tracker,
  program: (slug: string) => ["novus", "program", slug] as const,
  readiness: (id: string) => ["novus", "readiness", id] as const,
  cards: ["novus", "release-cards"] as const,
};

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function useSession() {
  return useQuery({
    queryKey: KEYS.session,
    staleTime: 5 * 60_000,
    queryFn: fetchSession,
    select: (s: Sourced<MeSessionResponse>): Loaded<MeSessionResponse> => toLoaded(s),
  });
}

export function useProgramDetail(slug: string | undefined) {
  return useQuery({
    queryKey: KEYS.program(slug ?? ""),
    enabled: Boolean(slug),
    staleTime: 60_000,
    queryFn: ({ signal }): Promise<Loaded<ProgramDetail>> =>
      loadWithSample(() => api.call("getProgram", { params: { slug: slug as string }, signal }), () => SAMPLE_PROGRAM_DETAIL),
  });
}

/** Readiness as the screens need it: a report, withheld (status-defined programs), or signed out. */
export type ReadinessState =
  | { kind: "report"; report: ReadinessReport; sample: boolean }
  | { kind: "withheld" }
  | { kind: "signed_out" };

export function useReadiness(programCycleId: string | undefined) {
  return useQuery({
    queryKey: KEYS.readiness(programCycleId ?? ""),
    enabled: Boolean(programCycleId),
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<ReadinessState> => {
      try {
        const loaded = await loadWithSample(
          () => api.call("getReadiness", { params: { programCycleId: programCycleId as string }, signal }),
          () => ({ report: SAMPLE_READINESS }),
        );
        return { kind: "report", report: loaded.data.report, sample: loaded.sample };
      } catch (err) {
        // The server answers 404 (with a problem document) for status-defined programs: readiness
        // is then built on the device. A bare 404 means "no API" and was handled above.
        if (isProblemStatus(err, 404)) return { kind: "withheld" };
        if (isProblemStatus(err, 401)) return { kind: "signed_out" };
        throw err;
      }
    },
  });
}

export function useTracker() {
  return useQuery({
    queryKey: KEYS.tracker,
    staleTime: 15_000,
    queryFn: fetchTracker,
    select: (s: Sourced<TrackerItem[]>): Loaded<TrackerItem[]> => toLoaded(s),
  });
}

/** Sample cards from both fixture sets, so sample tracker items always find their card. */
function sampleCardMap(): Map<string, ProgramCard> {
  return new Map([...sampleProgramCards(), ...SAMPLE_CARDS].map((c) => [c.slug, c]));
}

/**
 * Program cards from the immutable release artifact (client-core), keyed by slug. The Tracker
 * joins its items to these for names and deadlines without one request per program.
 */
export function useReleaseCards() {
  return useQuery({
    queryKey: KEYS.cards,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }): Promise<Loaded<Map<string, ProgramCard>>> =>
      loadWithSample(async () => {
        const pointer = await fetchReleaseFile(ROUTES.releasePointer, { schema: ROUTES.releasePointer.response, signal });
        const artifact = (await fetchReleaseFile(ROUTES.clientCore, { params: { file: `${pointer.release}.json` }, signal })) as ReleaseArtifact;
        return new Map(artifact.cards.map((c) => [c.slug, c]));
      }, sampleCardMap),
  });
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

type TrackerCache = Sourced<TrackerItem[]> | undefined;

function nowIso(): string {
  return new Date().toISOString();
}

function trackerIsSample(cache: TrackerCache): boolean {
  return cache?.source === "sample" || samplesForced();
}

/** Track a cycle. Answers 409 consent_required for status- or identity-defined programs. */
export function useTrackProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { programCycleId: string; programSlug: string; cycleKey: string }): Promise<TrackerItem> => {
      if (trackerIsSample(qc.getQueryData<TrackerCache>(KEYS.tracker))) {
        return {
          id: crypto.randomUUID(),
          programCycleId: input.programCycleId,
          programSlug: input.programSlug,
          cycleKey: input.cycleKey,
          status: "interested",
          statusSource: "student",
          ownCampusDeadline: null,
          submittedOn: null,
          nameInMessages: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          version: 1,
        };
      }
      return api.call("addTracker", { body: { programCycleId: input.programCycleId, status: "interested", nameInMessages: true } });
    },
    onSuccess: (item) => {
      qc.setQueryData<TrackerCache>(KEYS.tracker, (prev) => ({
        data: [...(prev?.data ?? []).filter((i) => i.id !== item.id), item],
        source: prev?.source ?? "live",
      }));
    },
  });
}

export function useUntrackProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      if (!trackerIsSample(qc.getQueryData<TrackerCache>(KEYS.tracker))) await api.call("removeTracker", { params: { id } });
      return id;
    },
    onSuccess: (id) => {
      qc.setQueryData<TrackerCache>(KEYS.tracker, (prev) => (prev ? { ...prev, data: prev.data.filter((i) => i.id !== id) } : prev));
    },
  });
}

/**
 * Updates a tracked cycle optimistically. A 409 version_conflict means another tab or an email
 * action changed it first: the cache is refetched and the error surfaces to the caller.
 */
export function useUpdateTrackerItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: TrackerItemUpdate }): Promise<TrackerItem> => {
      const cache = qc.getQueryData<TrackerCache>(KEYS.tracker);
      const current = cache?.data.find((i) => i.id === input.id);
      if (trackerIsSample(cache) && current) {
        const { version: _seen, ...rest } = input.patch;
        return { ...current, ...rest, statusSource: "student", updatedAt: nowIso(), version: current.version + 1 };
      }
      return api.call("updateTracker", { params: { id: input.id }, body: input.patch });
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: KEYS.tracker });
      const previous = qc.getQueryData<TrackerCache>(KEYS.tracker);
      qc.setQueryData<TrackerCache>(KEYS.tracker, (prev) => {
        if (!prev) return prev;
        const { version: _v, ...rest } = input.patch;
        return { ...prev, data: prev.data.map((i) => (i.id === input.id ? { ...i, ...rest } : i)) };
      });
      return { previous };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(KEYS.tracker, ctx.previous);
      if (err instanceof ApiError && err.code === "version_conflict") void qc.invalidateQueries({ queryKey: KEYS.tracker });
    },
    onSuccess: (item) => {
      qc.setQueryData<TrackerCache>(KEYS.tracker, (prev) => (prev ? { ...prev, data: prev.data.map((i) => (i.id === item.id ? item : i)) } : prev));
    },
  });
}

/**
 * Saves checklist progress. Status-defined programs refuse progress without consent (409); the
 * caller then keeps the tick on this device only. Sample mode never touches the network.
 */
export function useSaveRequirementProgress(programCycleId: string, sample: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RequirementProgressUpdate): Promise<"saved" | "device_only"> => {
      if (sample) return "device_only";
      try {
        await api.call("putRequirementProgress", { body });
        return "saved";
      } catch (err) {
        if (err instanceof ApiError && (err.code === "consent_required" || err.status === 409)) return "device_only";
        throw err;
      }
    },
    onSuccess: (outcome) => {
      if (outcome === "saved") void qc.invalidateQueries({ queryKey: KEYS.readiness(programCycleId) });
    },
  });
}

/** Pins a next action's Roadmap item so it shows on the student's Roadmap. */
export function useRoadmapAction(sample: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { itemKey: string; action: RoadmapItemAction["action"] }): Promise<string> => {
      if (!sample) await api.call("updateRoadmapItem", { params: { itemKey: input.itemKey }, body: { action: input.action } });
      return input.itemKey;
    },
    onSuccess: () => {
      if (!sample) void qc.invalidateQueries({ queryKey: queryKeys.roadmap });
    },
  });
}

/**
 * Asks the readiness assistant (Gemini, through the Worker) to explain the report. The request
 * carries only a focus and an optional question; no private answer is ever part of it. With no
 * API, a deterministic explanation built from the report is shown instead.
 */
export function useExplainReadiness(report: ReadinessReport, sample: boolean) {
  return useMutation({
    mutationFn: async (body: ReadinessExplainRequest): Promise<ReadinessExplainResponse> => {
      if (sample) return fallbackExplanation(report, "unavailable");
      try {
        return await api.call("explainReadiness", { params: { programCycleId: report.programCycleId }, body });
      } catch (err) {
        if (isApiUnavailable(err) || (err instanceof ApiError && err.code === "ai_unavailable")) return fallbackExplanation(report, "unavailable");
        throw err;
      }
    },
  });
}

export { KEYS as READINESS_QUERY_KEYS };
