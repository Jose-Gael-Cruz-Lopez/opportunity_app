import { eq } from "drizzle-orm";
import type { BandModel } from "@shared/readiness/bands";
import { decideProgramBand } from "@shared/readiness/bands-store";
import type { BandGateFlags } from "@shared/readiness/outcomes";
import type { Db } from "@server/db/client";
import { readProgramBandFacts, type ProgramBandFacts } from "@server/db/repos/bands";
import * as s from "@server/db/schema";

/**
 * The public outcome summary's band status, decided by the same read-time rule readiness uses
 * (shared/readiness/bands-store `decideProgramBand` over `readProgramBandFacts`): a live
 * founder approval of this exact model card, a model under the age limit, no held cycle, the
 * program's own eligibility and n_eff, the fitted gates, and never a sensitive-audience
 * program. The summary is "live" when any of the program's stored transitions decides live
 * today (UTC); otherwise null, which reads "official base rate only".
 *
 * Replaces the old R2 read (`bandGatesForTypes`), which trusted the fit-time `approved` flag and
 * ignored revocation, staleness, holds and per-program eligibility.
 */
export function bandGatesFromFacts(facts: ProgramBandFacts, ctx: { programId: string; sensitiveAudience: boolean; nowMs: number }): BandGateFlags | null {
  const today = new Date(ctx.nowMs).toISOString().slice(0, 10);
  const transitions = new Map<string, { fromStage: string; toStage: string }>();
  for (const r of facts.rows) transitions.set(`${r.fromStage}|${r.toStage}`, { fromStage: r.fromStage, toStage: r.toStage });
  for (const transition of [...transitions.values()].sort((a, b) => `${a.fromStage}|${a.toStage}`.localeCompare(`${b.fromStage}|${b.toStage}`))) {
    const decision = decideProgramBand<BandModel>(facts.rows, {
      programId: ctx.programId,
      opportunityTypes: facts.opportunityTypes,
      sensitiveAudience: ctx.sensitiveAudience,
      transition,
      today,
      approvedModelKeys: facts.approvedModelKeys,
      heldCycleIds: facts.heldCycleIds,
    });
    if (decision.live) return decision.model.gates;
  }
  return null;
}

export async function programBandGates(db: Db, programId: string, nowMs: number): Promise<BandGateFlags | null> {
  const [program] = await db.select({ sensitive: s.programs.sensitiveAudience }).from(s.programs).where(eq(s.programs.id, programId)).limit(1);
  if (!program) return null;
  const facts = await readProgramBandFacts(db, programId, nowMs);
  if (facts.rows.length === 0) return null;
  return bandGatesFromFacts(facts, { programId, sensitiveAudience: program.sensitive, nowMs });
}
