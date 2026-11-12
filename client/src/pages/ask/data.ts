import { useMutation } from "@tanstack/react-query";
import type { AskResponse } from "@shared/contracts";
import { callRoute } from "@/components/forms/request";
import { DATA_MODE, liveOrSample, type DataMode } from "@/lib/data-source";
import { useSession } from "@/lib/queries";
import { sampleAskResponse } from "./fixtures";

/**
 * Ask Novus data: POST /api/v1/me/ask. The server degrades to a deterministic answer when it has
 * no Gemini key, so a response always comes back; only a missing API falls back to sample data.
 */

export interface AskResult {
  readonly response: AskResponse;
  readonly sample: boolean;
}

export async function ask(question: string, programSlug: string | null, mode: DataMode = DATA_MODE): Promise<AskResult> {
  const sourced = await liveOrSample(
    () => callRoute("ask", { body: { question, programSlug } }),
    () => sampleAskResponse(question, new Date().toISOString()),
    mode,
  );
  return { response: sourced.data, sample: sourced.source === "sample" };
}

export function useAsk() {
  return useMutation({ mutationFn: (v: { question: string; programSlug: string | null }) => ask(v.question, v.programSlug) });
}

/** The display name for the greeting, when signed in (the shared session cache; may be sample). */
export function useDisplayName(): string | null {
  const q = useSession();
  const name = q.data?.data.user?.displayName?.trim();
  return name ? (name.split(/\s+/)[0] ?? null) : null;
}
