import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AskRequest, AskResponse } from "@shared/contracts/ai";
import type { ProgramListQuery } from "@shared/contracts/api";
import type { InboxItem } from "@shared/contracts/events";
import type { ProgramCard } from "@shared/contracts/registry";
import type { Roadmap, RoadmapItemAction } from "@shared/contracts/roadmap";
import type { MeSessionResponse, TrackerItem, TrackerItemUpdate } from "@shared/contracts/student";
import type { TrackerStatus } from "@shared/taxonomy";
import { api, ApiError, type ApiClient } from "./api";
import { liveOrSample, type Sourced } from "./data-source";
import { sampleProgramCards } from "./fixtures/programs";
import { sampleInbox, sampleRoadmap, sampleSession, sampleTracker } from "./fixtures/student";

/**
 * Query keys and hooks for the app. Each hook returns `Sourced<T>` so a screen can tell sample
 * data from live data and label it. Pages owned by other agents should use these hooks (or add
 * new ones here) instead of calling fetch directly.
 */

export const queryKeys = {
  session: ["me", "session"] as const,
  tracker: ["me", "tracker"] as const,
  inbox: ["me", "inbox"] as const,
  roadmap: ["me", "roadmap"] as const,
  readiness: (programCycleId: string) => ["me", "readiness", programCycleId] as const,
  programs: (query: Partial<ProgramListQuery> = {}) => ["programs", query] as const,
  program: (slug: string) => ["program", slug] as const,
  opportunityTypes: ["opportunity-types"] as const,
  deadlines: (withinDays: number) => ["deadlines", withinDays] as const,
};

/** Upper bound on pages fetched for the full program list (100 cards per page). */
const MAX_PROGRAM_PAGES = 10;

export async function fetchAllPrograms(client: ApiClient, query: Partial<ProgramListQuery> = {}): Promise<ProgramCard[]> {
  const cards: ProgramCard[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROGRAM_PAGES; page++) {
    const res = await client.call("listPrograms", { query: { ...query, limit: 100, cursor } });
    cards.push(...res.items);
    if (!res.page.nextCursor) break;
    cursor = res.page.nextCursor;
  }
  return cards;
}

// ---- Reads -----------------------------------------------------------------------------------

/**
 * Shared loaders. Every hook that reads one of these keys, in any module, must use the matching
 * loader so the cache holds one shape per key (`Sourced<T>`); modules that want another shape
 * use `select`.
 */
export function fetchSession(): Promise<Sourced<MeSessionResponse>> {
  return liveOrSample(() => api.call("meSession"), sampleSession);
}

export function fetchTracker(): Promise<Sourced<TrackerItem[]>> {
  return liveOrSample(async () => (await api.call("listTracker")).items, () => sampleTracker());
}

export function fetchRoadmap(): Promise<Sourced<Roadmap>> {
  return liveOrSample(() => api.call("getRoadmap"), () => sampleRoadmap());
}

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: fetchSession,
    staleTime: 5 * 60_000,
  });
}

export function usePrograms(query: Partial<ProgramListQuery> = {}) {
  return useQuery({
    queryKey: queryKeys.programs(query),
    queryFn: (): Promise<Sourced<ProgramCard[]>> => liveOrSample(() => fetchAllPrograms(api, query), () => sampleProgramCards()),
    staleTime: 5 * 60_000,
  });
}

// Program detail and readiness live in components/readiness/data.ts (keys under "novus").

export function useOpportunityTypes() {
  return useQuery({
    queryKey: queryKeys.opportunityTypes,
    queryFn: () => api.call("listOpportunityTypes"),
    staleTime: 60 * 60_000,
  });
}

/** Signed-in reads are disabled until the session says someone is signed in. */
function useSignedIn(): boolean {
  const session = useSession();
  return !!session.data?.data.user;
}

export function useTracker() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.tracker,
    queryFn: fetchTracker,
    enabled: signedIn,
  });
}

export function useInbox() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.inbox,
    queryFn: (): Promise<Sourced<InboxItem[]>> => liveOrSample(async () => (await api.call("inbox", { query: { limit: 20 } })).items, () => sampleInbox()),
    enabled: signedIn,
  });
}

export function useRoadmap() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.roadmap,
    queryFn: fetchRoadmap,
    enabled: signedIn,
  });
}

// ---- Writes ----------------------------------------------------------------------------------

function cachedSource(qc: QueryClient, key: readonly unknown[]): Sourced<unknown>["source"] | undefined {
  return qc.getQueryData<Sourced<unknown>>(key)?.source;
}

/** Applies a roadmap action to a cached plan (used optimistically and for sample data). */
export function applyRoadmapAction(roadmap: Roadmap, itemKey: string, action: RoadmapItemAction["action"]): Roadmap {
  const patch = (state: Roadmap["terms"][number]["prepare"][number]) => {
    if (state.itemKey !== itemKey) return state;
    switch (action) {
      case "complete":
        return { ...state, state: "done" as const };
      case "reopen":
      case "restore":
        return { ...state, state: "open" as const };
      case "dismiss":
        return { ...state, state: "dismissed" as const };
      case "pin":
        return { ...state, pinned: true };
      case "unpin":
        return { ...state, pinned: false };
    }
  };
  return {
    ...roadmap,
    terms: roadmap.terms.map((t) => ({ ...t, apply: t.apply.map(patch), prepare: t.prepare.map(patch), milestones: t.milestones.map(patch) })),
  };
}

export function useRoadmapAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemKey, action }: { itemKey: string; action: RoadmapItemAction["action"] }) => {
      if (cachedSource(qc, queryKeys.roadmap) === "sample") return;
      await api.call("updateRoadmapItem", { params: { itemKey }, body: { action } });
    },
    onMutate: async ({ itemKey, action }) => {
      await qc.cancelQueries({ queryKey: queryKeys.roadmap });
      const previous = qc.getQueryData<Sourced<Roadmap>>(queryKeys.roadmap);
      if (previous) qc.setQueryData<Sourced<Roadmap>>(queryKeys.roadmap, { ...previous, data: applyRoadmapAction(previous.data, itemKey, action) });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.roadmap, context.previous);
    },
    onSettled: () => {
      if (cachedSource(qc, queryKeys.roadmap) !== "sample") void qc.invalidateQueries({ queryKey: queryKeys.roadmap });
    },
  });
}

/** Track a program cycle. Status- or identity-defined programs answer 409 consent_required. */
export function useTrackProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ card, status = "interested" }: { card: Pick<ProgramCard, "programCycleId" | "slug" | "cycleKey">; status?: TrackerStatus }): Promise<TrackerItem> => {
      if (cachedSource(qc, queryKeys.tracker) === "sample") {
        const now = new Date().toISOString();
        return {
          id: `00000000-0000-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, "0")}`,
          programCycleId: card.programCycleId,
          programSlug: card.slug,
          cycleKey: card.cycleKey,
          status,
          statusSource: "student",
          ownCampusDeadline: null,
          submittedOn: null,
          nameInMessages: true,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
      }
      return api.call("addTracker", { body: { programCycleId: card.programCycleId, status } });
    },
    onSuccess: (item) => {
      const previous = qc.getQueryData<Sourced<TrackerItem[]>>(queryKeys.tracker);
      if (previous) qc.setQueryData<Sourced<TrackerItem[]>>(queryKeys.tracker, { ...previous, data: [item, ...previous.data.filter((t) => t.id !== item.id)] });
      if (previous?.source !== "sample") void qc.invalidateQueries({ queryKey: queryKeys.tracker });
    },
  });
}

export function useUntrackProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: Pick<TrackerItem, "id">) => {
      if (cachedSource(qc, queryKeys.tracker) !== "sample") await api.call("removeTracker", { params: { id: item.id } });
      return item.id;
    },
    onSuccess: (id) => {
      const previous = qc.getQueryData<Sourced<TrackerItem[]>>(queryKeys.tracker);
      if (previous) qc.setQueryData<Sourced<TrackerItem[]>>(queryKeys.tracker, { ...previous, data: previous.data.filter((t) => t.id !== id) });
    },
  });
}

export function useUpdateTracker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, update }: { item: TrackerItem; update: Omit<TrackerItemUpdate, "version"> }): Promise<TrackerItem> => {
      if (cachedSource(qc, queryKeys.tracker) === "sample") return { ...item, ...update, version: item.version + 1, updatedAt: new Date().toISOString() };
      return api.call("updateTracker", { params: { id: item.id }, body: { ...update, version: item.version } });
    },
    onSuccess: (item) => {
      const previous = qc.getQueryData<Sourced<TrackerItem[]>>(queryKeys.tracker);
      if (previous) qc.setQueryData<Sourced<TrackerItem[]>>(queryKeys.tracker, { ...previous, data: previous.data.map((t) => (t.id === item.id ? item : t)) });
    },
  });
}

/**
 * Ask Novus. The question is free text the student typed; the server strips and refuses status
 * or identity judgments. There is no sample answer: without the API the error says so.
 */
export function useAsk() {
  return useMutation({
    mutationFn: (request: AskRequest): Promise<AskResponse> => api.call("ask", { body: request }),
  });
}

export { ApiError };
