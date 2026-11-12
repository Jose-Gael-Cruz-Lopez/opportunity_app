import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClassYear, Roadmap, RoadmapItemAction, TrackerItem } from "@shared/contracts";
import { callRoute, isUnauthenticated } from "@/components/forms/request";
import { liveOrSample } from "@/lib/data-source";
import { useSession } from "@/lib/queries";
import { humanizeSlug } from "@/components/forms/dates";
import { SAMPLE_PROGRAM_NAMES, sampleNextActions, sampleRoadmap } from "./fixtures";
import { applyActionToItem, buildPlan, requirementSubject, type NextActionContext, type Plan, type PlanItem } from "./model";

/**
 * Data for the Roadmap page: the server plan (GET /api/v1/me/roadmap) plus next actions from the
 * readiness reports of tracked cycles. Falls back to labelled sample data when no API answers.
 */

export type RoadmapSource = "live" | "sample" | "signed_out";

/** Readiness reports are fetched for at most this many tracked cycles, to bound requests. */
const MAX_READINESS_FETCHES = 8;
const ACTIVE_STATUSES: ReadonlySet<TrackerItem["status"]> = new Set(["interested", "applying"]);

async function loadNextActions(signal: AbortSignal): Promise<NextActionContext[]> {
  const { items } = await callRoute("listTracker", { signal });
  const active = items.filter((t) => ACTIVE_STATUSES.has(t.status)).slice(0, MAX_READINESS_FETCHES);
  const settled = await Promise.allSettled(
    active.map((t) => callRoute("getReadiness", { params: { programCycleId: t.programCycleId }, signal })),
  );
  const contexts: NextActionContext[] = [];
  settled.forEach((res, i) => {
    const tracked = active[i];
    // A 404 is expected for status-defined programs, whose readiness lives on the device only.
    if (res.status !== "fulfilled" || !tracked) return;
    const report = res.value.report;
    contexts.push({
      programCycleId: report.programCycleId,
      programSlug: report.programSlug,
      programName: null,
      cycleKey: report.cycleKey,
      actions: report.nextActions,
    });
  });
  return contexts;
}

export interface RoadmapData {
  readonly source: RoadmapSource;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly plan: Plan | null;
  readonly generatedAt: string | null;
  readonly act: (item: PlanItem, action: RoadmapItemAction["action"]) => Promise<void>;
  readonly pending: ReadonlySet<string>;
  readonly retry: () => void;
}

type Override = Pick<PlanItem, "state" | "pinned">;

function withOverrides(plan: Plan, overrides: ReadonlyMap<string, Override>): Plan {
  if (overrides.size === 0) return plan;
  return {
    ...plan,
    terms: plan.terms.map((t) => ({
      ...t,
      items: t.items.map((i) => {
        const o = overrides.get(i.itemKey);
        return o ? { ...i, ...o } : i;
      }),
    })),
  };
}

export function useRoadmapData(today: string): RoadmapData {
  // Its own key under ["me", "roadmap"]: the shell's Home card caches `Sourced<Roadmap>` at that
  // exact key, and invalidating the prefix after a change refreshes both.
  const roadmapQ = useQuery({
    queryKey: ["me", "roadmap", "page"],
    queryFn: ({ signal }) => liveOrSample<Roadmap | null>(() => callRoute("getRoadmap", { signal }), () => null),
    retry: false,
    staleTime: 60_000,
  });
  const liveRoadmap = roadmapQ.data?.source === "live" ? roadmapQ.data.data : null;
  const live = liveRoadmap !== null;
  const actionsQ = useQuery({
    queryKey: ["me", "roadmap", "next-actions"],
    queryFn: ({ signal }) => loadNextActions(signal),
    enabled: live,
    retry: false,
    staleTime: 60_000,
  });

  const unreachable = roadmapQ.data?.source === "sample";
  const signedOut = roadmapQ.isError && isUnauthenticated(roadmapQ.error);
  const source: RoadmapSource = live ? "live" : signedOut ? "signed_out" : "sample";

  const basePlan = useMemo((): Plan | null => {
    if (liveRoadmap) {
      const names = new Map<string, string>();
      for (const t of liveRoadmap.terms) {
        for (const i of [...t.apply, ...t.prepare, ...t.milestones]) {
          if (i.programSlug) names.set(i.programSlug, humanizeSlug(i.programSlug));
        }
      }
      return buildPlan(liveRoadmap, actionsQ.data ?? [], today, names);
    }
    if (unreachable || signedOut) return buildPlan(sampleRoadmap(today), sampleNextActions(today), today, SAMPLE_PROGRAM_NAMES);
    return null;
  }, [liveRoadmap, actionsQ.data, unreachable, signedOut, today]);

  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const act = useCallback(
    async (item: PlanItem, action: RoadmapItemAction["action"]) => {
      const before: Override = { state: item.state, pinned: item.pinned };
      const after = applyActionToItem(item, action);
      setOverrides((m) => new Map(m).set(item.itemKey, { state: after.state, pinned: after.pinned }));
      if (source !== "live") return; // sample mode: the change stays on this page only
      setPending((s) => new Set(s).add(item.itemKey));
      try {
        const subject = item.origin === "next_action" ? requirementSubject(item.relatesTo) : null;
        if (subject && (action === "complete" || action === "reopen")) {
          await callRoute("putRequirementProgress", {
            body: { subjectKey: subject, state: action === "complete" ? "met" : "in_progress" },
          });
        } else {
          await callRoute("updateRoadmapItem", { params: { itemKey: item.itemKey }, body: { action } });
        }
      } catch (err) {
        setOverrides((m) => new Map(m).set(item.itemKey, before));
        throw err;
      } finally {
        setPending((s) => {
          const next = new Set(s);
          next.delete(item.itemKey);
          return next;
        });
      }
    },
    [source],
  );

  const plan = useMemo(() => (basePlan ? withOverrides(basePlan, overrides) : null), [basePlan, overrides]);

  return {
    source,
    loading: roadmapQ.isPending,
    error: roadmapQ.isError && !signedOut ? (roadmapQ.error as Error) : null,
    plan,
    generatedAt: liveRoadmap ? liveRoadmap.generatedAt : null,
    act,
    pending,
    retry: () => void roadmapQ.refetch(),
  };
}

/** The class year sample data assumes, so "Y2" labels line up with the sample plan. */
export const SAMPLE_CLASS_YEAR = "second_year" as const;

export function useProfileClassYear(): ClassYear | null {
  const q = useSession();
  return q.data?.data.profile?.classYear ?? null;
}
