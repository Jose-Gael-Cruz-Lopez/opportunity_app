import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { InboxItem, NotificationPrefs } from "@shared/contracts/events";
import { api } from "@/lib/api";
import { liveOrSample, type Sourced } from "@/lib/data-source";
import { DEFAULT_SAMPLE_PREFS, sampleNotifications } from "./fixtures";
import { markEachRead, withReadAt } from "./model";

/**
 * Data for the notification center: the paginated inbox (`GET /api/v1/me/activity`), marking
 * items read (`POST /api/v1/me/activity/:id/read`) and the student's notification preferences.
 * Keys live under ["me", "notifications"], separate from the home page's ["me", "inbox"] (a
 * different shape); marking read refreshes both.
 */

export const notificationKeys = {
  pages: ["me", "notifications", "pages"] as const,
  prefs: ["me", "notifications", "prefs"] as const,
};

const PAGE_SIZE = 25;

export interface InboxPage {
  readonly items: InboxItem[];
  readonly nextCursor: string | null;
  readonly sample: boolean;
}

export function useNotificationPages(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: notificationKeys.pages,
    initialPageParam: null as string | null,
    enabled,
    queryFn: async ({ pageParam }): Promise<InboxPage> => {
      const res: Sourced<{ items: InboxItem[]; nextCursor: string | null }> = await liveOrSample(
        async () => {
          const page = await api.call("inbox", { query: { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) } });
          return { items: page.items, nextCursor: page.page.nextCursor };
        },
        () => ({ items: sampleNotifications(), nextCursor: null }),
      );
      return { ...res.data, sample: res.source === "sample" };
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useNotificationPrefs(enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.prefs,
    enabled,
    queryFn: (): Promise<Sourced<NotificationPrefs>> => liveOrSample(() => api.call("getNotificationPrefs"), () => DEFAULT_SAMPLE_PREFS),
    staleTime: 5 * 60_000,
  });
}

type Pages = InfiniteData<InboxPage, string | null>;

/** Marks one item read: optimistic, then the server; sample items stay local. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sample }: { id: string; sample: boolean }) => {
      if (sample) return;
      await api.call("markInboxRead", { params: { id }, body: {} });
    },
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: notificationKeys.pages });
      setRead(qc, [id], new Date().toISOString());
    },
    // Undo only this item. Restoring a whole snapshot would also undo reads that other requests
    // (sent at the same time) already saved.
    onError: (_err, { id }) => setRead(qc, [id], null),
    onSettled: (_data, _err, vars) => refreshAfterRead(qc, vars.sample),
  });
}

/**
 * Marks many items read with one optimistic update and one request per item, then undoes only
 * the ones that failed and reports the real count (`{ done, failed }`).
 */
export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, sample }: { ids: string[]; sample: boolean }) => {
      if (sample) return { done: ids, failed: [] as string[] };
      return markEachRead(ids, (id) => api.call("markInboxRead", { params: { id }, body: {} }));
    },
    onMutate: async ({ ids }) => {
      await qc.cancelQueries({ queryKey: notificationKeys.pages });
      setRead(qc, ids, new Date().toISOString());
    },
    onSuccess: (result) => {
      if (result.failed.length) setRead(qc, result.failed, null);
    },
    onError: (_err, { ids }) => setRead(qc, ids, null),
    onSettled: (_data, _err, vars) => refreshAfterRead(qc, vars.sample),
  });
}

function setRead(qc: QueryClient, ids: readonly string[], readAt: string | null): void {
  const set = new Set(ids);
  qc.setQueryData<Pages>(notificationKeys.pages, (data) => (data ? { ...data, pages: withReadAt(data.pages, set, readAt) } : data));
}

/** The server's word wins once requests settle: the center's pages and the home inbox. */
function refreshAfterRead(qc: QueryClient, sample: boolean): void {
  if (sample) return;
  void qc.invalidateQueries({ queryKey: notificationKeys.pages });
  void qc.invalidateQueries({ queryKey: ["me", "inbox"] });
}
