/**
 * Per-invocation budget (architecture 2.3.7): the tick gets about 25 s and 900 D1 calls, which
 * the job registry shares out by kind. Each kind spends from its own share and from the
 * invocation total, so one slow kind cannot starve the rest and leftover work carries over.
 *
 * Workers freeze Date.now() during pure CPU work and advance it on I/O, so elapsed time here is
 * mostly I/O wait. That is the cost that matters for D1-bound jobs; CPU limits are enforced by
 * the runtime itself.
 */
export class Budget {
  private calls = 0;
  private readonly startedAt: number;

  constructor(
    private readonly limits: { ms: number; calls: number },
    private readonly clock: () => number,
    private readonly parent: Budget | null = null,
  ) {
    this.startedAt = clock();
  }

  /** A child budget: `fraction` of this budget's limits, never more than what is left. */
  share(fraction: number): Budget {
    const f = Math.max(0, Math.min(1, fraction));
    return new Budget(
      {
        ms: Math.min(Math.floor(this.limits.ms * f), this.remainingMs),
        calls: Math.min(Math.floor(this.limits.calls * f), this.remainingCalls),
      },
      this.clock,
      this,
    );
  }

  /** Records D1 calls (approximate: one per statement or batch round trip). */
  spend(calls = 1): void {
    this.calls += calls;
    this.parent?.spend(calls);
  }

  get spentCalls(): number {
    return this.calls;
  }

  get remainingCalls(): number {
    return Math.max(0, this.limits.calls - this.calls);
  }

  get remainingMs(): number {
    return Math.max(0, this.limits.ms - (this.clock() - this.startedAt));
  }

  /** True once either limit is used up (or the parent's is). */
  get exhausted(): boolean {
    return this.remainingCalls <= 0 || this.remainingMs <= 0 || (this.parent?.exhausted ?? false);
  }

  /** Whether `calls` more D1 calls fit; handlers check this before starting a unit of work. */
  allows(calls = 1): boolean {
    return !this.exhausted && this.remainingCalls >= calls && (this.parent ? this.parent.allows(calls) : true);
  }
}

/** Invocation limits by trigger (the tick's are the plan's; hourly and daily get 10 minutes). */
export const TRIGGER_LIMITS = {
  tick: { ms: 25_000, calls: 900 },
  hourly: { ms: 600_000, calls: 900 },
  daily: { ms: 600_000, calls: 900 },
} as const;
