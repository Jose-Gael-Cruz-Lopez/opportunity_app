import type { Context } from "hono";
import { createAi, type AiEnv } from "@server/ai";
import { requireSignedIn } from "@server/api/v1/student/routes";
import { getDb } from "@server/db/client";
import type { AppEnv } from "@server/env";
import { loadFlags } from "@server/lib/flags";
import { createD1OnboardingRepos } from "./d1";
import { sharedMatchEngine } from "./engine";
import type { OnboardingDeps, OnboardingEnv, ResumeAi, ResumeExtractResult } from "./ports";

/**
 * Binds the onboarding routes to the real modules:
 * - auth: the student surface's requireSignedIn (401 without a session); the internal user id
 *   comes from the session middleware's `user` variable and never leaves the server;
 * - repos: D1 through server/db/repos (d1.ts), including the registry catalog adapter;
 * - engine: @shared/onboarding, the same engine the browser runs (engine.ts);
 * - AI: server/ai's extractResumeProfile, behind the `llm.all` and `llm.resume_extract` kill
 *   switches. Only a model reading counts as "ai: on"; the deterministic fallback reports
 *   "unavailable" so the browser keeps its own on-device parse and says AI did not read it.
 */

type WiredEnv = OnboardingEnv & AiEnv & { readonly DB?: D1Database };

/** True when both LLM kill switches are on (their default). A flag read error keeps them on. */
async function resumeExtractAllowed(env: WiredEnv): Promise<boolean> {
  try {
    const flags = await loadFlags(env as unknown as Parameters<typeof loadFlags>[0]);
    return flags.values["llm.all"] && flags.values["llm.resume_extract"];
  } catch {
    return true;
  }
}

export function createResumeAi(env: WiredEnv): ResumeAi {
  return {
    async extractResumeProfile(redactedText, viewer): Promise<ResumeExtractResult> {
      const allowed = await resumeExtractAllowed(env);
      const ai = createAi(allowed ? env : { ...env, AI_DISABLED: "true" });
      const result = await ai.extractResumeProfile(redactedText, {
        viewer: viewer ? { userId: viewer.userId, birthYearMonth: viewer.birthYearMonth } : undefined,
      });
      if (result.source !== "model" || result.meta.fallback) return { status: "unavailable" };
      return { status: "ok", profile: result.profile };
    },
  };
}

export const onboardingDeps: OnboardingDeps = {
  auth: {
    requireUser: requireSignedIn as OnboardingDeps["auth"]["requireUser"],
    userId: (c: Context) => (c as unknown as Context<AppEnv>).get("user")?.id ?? null,
  },
  repos: (c: Context) => createD1OnboardingRepos(getDb((c as unknown as Context<AppEnv>).env.DB)),
  engine: sharedMatchEngine,
  createAi: (env: OnboardingEnv) => createResumeAi(env as WiredEnv),
  now: () => new Date(),
};
