import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { ProblemDetailsSchema } from "@shared/contracts/common";
import type { CampusDeadlineSubmission, ProgramListCreate, ProgramListUpdate } from "@shared/contracts/advisor";
import { api, ApiError } from "@/lib/api";
import { liveOrSample, type Sourced } from "@/lib/data-source";
import { CampusViewSchema, ProgressViewSchema, type CampusView, type ProgressView } from "./model";
import { SAMPLE_CAMPUS, SAMPLE_WORKSPACES, sampleLists, sampleProgress, sampleReport } from "./fixtures";

/**
 * Data for the advisor screen. Route-map endpoints go through lib/api; the advisor-only reads
 * that are not in the route map yet (progress, campus view, delete) use `advisorFetch`, which
 * keeps the same error kinds. When no API answers, reads fall back to labelled sample data.
 */

const BASE = "/api/v1";

async function advisorFetch<S extends z.ZodTypeAny>(path: string, init: RequestInit, schema: S | null): Promise<z.output<S> | undefined> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { credentials: "same-origin", headers: { accept: "application/json" }, ...init });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("network", "Could not reach Novus.");
  }
  if (res.status === 204) return undefined;
  const type = res.headers.get("content-type") ?? "";
  if (!/\bjson\b/.test(type)) throw new ApiError("not_api", `Expected JSON from ${path}`, { status: res.status });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(json);
    throw new ApiError(problem.success ? "problem" : "invalid_response", problem.success ? problem.data.title : `Request failed with ${res.status}`, {
      status: res.status,
      problem: problem.success ? problem.data : null,
    });
  }
  if (!schema) return json as z.output<S>;
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("invalid_response", `Response from ${path} did not match`, { status: res.status });
  return parsed.data;
}

const KEYS = {
  workspaces: ["advisor", "workspaces"] as const,
  lists: (ws: string) => ["advisor", ws, "lists"] as const,
  progress: (ws: string) => ["advisor", ws, "progress"] as const,
  campus: (ws: string) => ["advisor", ws, "campus"] as const,
  report: (ws: string, period: string) => ["advisor", ws, "report", period] as const,
};

/** True once the workspace list itself came from samples; later reads follow it. */
let sampleMode = false;

export function useWorkspaces() {
  return useQuery({
    queryKey: KEYS.workspaces,
    queryFn: async () => {
      const res = await liveOrSample(async () => (await api.call("myWorkspaces")).items, () => SAMPLE_WORKSPACES);
      sampleMode = res.source === "sample";
      return res;
    },
  });
}

function read<T>(live: () => Promise<T>, sample: () => T): Promise<Sourced<T>> {
  return sampleMode ? Promise.resolve({ data: sample(), source: "sample" }) : liveOrSample(live, sample);
}

export function useLists(workspaceId: string | null) {
  return useQuery({
    queryKey: KEYS.lists(workspaceId ?? ""),
    enabled: !!workspaceId,
    queryFn: () => read(async () => (await api.call("listWorkspaceLists", { params: { workspaceId: workspaceId as string } })).items, () => sampleLists()),
  });
}

export function useProgress(workspaceId: string | null, period: string) {
  return useQuery({
    queryKey: KEYS.progress(workspaceId ?? ""),
    enabled: !!workspaceId,
    queryFn: () =>
      read<ProgressView>(
        async () => (await advisorFetch(`/workspaces/${encodeURIComponent(workspaceId as string)}/progress`, {}, ProgressViewSchema)) as ProgressView,
        () => sampleProgress(period),
      ),
  });
}

export function useCampus(workspaceId: string | null) {
  return useQuery({
    queryKey: KEYS.campus(workspaceId ?? ""),
    enabled: !!workspaceId,
    queryFn: () =>
      read<CampusView>(async () => (await advisorFetch(`/workspaces/${encodeURIComponent(workspaceId as string)}/campus-deadlines`, {}, CampusViewSchema)) as CampusView, () => SAMPLE_CAMPUS),
  });
}

export function useReport(workspaceId: string | null, period: string) {
  return useQuery({
    queryKey: KEYS.report(workspaceId ?? "", period),
    enabled: !!workspaceId,
    queryFn: () => read(() => api.call("workspaceReport", { params: { workspaceId: workspaceId as string, period } }), () => sampleReport(period)),
  });
}

/** Links for CSV downloads (plain GETs; the session cookie authorizes them). */
export function exportUrls(workspaceId: string) {
  const ws = encodeURIComponent(workspaceId);
  return {
    list: (listId: string) => `${BASE}/workspaces/${ws}/lists/${encodeURIComponent(listId)}/export.csv`,
    report: (period: string) => `${BASE}/workspaces/${ws}/reports/${encodeURIComponent(period)}/export.csv`,
  };
}

/** Writes refuse to run on sample data: there is nothing real to change. */
function assertLive(): void {
  if (sampleMode) throw new ApiError("network", "Sample data is on screen, so changes are not saved.");
}

export function useCreateList(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProgramListCreate) => {
      assertLive();
      return api.call("createWorkspaceList", { params: { workspaceId }, body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["advisor", workspaceId] }),
  });
}

export function useUpdateList(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, patch }: { listId: string; patch: ProgramListUpdate }) => {
      assertLive();
      return api.call("updateList", { params: { listId }, body: patch });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["advisor", workspaceId] }),
  });
}

export function useDeleteList(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (listId: string) => {
      assertLive();
      await advisorFetch(`/workspaces/${encodeURIComponent(workspaceId)}/lists/${encodeURIComponent(listId)}`, { method: "DELETE" }, null);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["advisor", workspaceId] }),
  });
}

export function useSubmitCampusDeadline(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampusDeadlineSubmission) => {
      assertLive();
      return api.call("submitCampusDeadline", { params: { workspaceId }, body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.campus(workspaceId) }),
  });
}
