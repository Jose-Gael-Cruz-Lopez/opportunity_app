/**
 * The only identifier telemetry sends: a random id scoped to one browsing session. It lives in
 * sessionStorage (per tab, gone when the tab closes), rotates after 30 idle minutes, and is
 * never a cookie, never written to localStorage, never derived from the account and never
 * joined to it. Where sessionStorage is unavailable (private modes, blocked storage) it lives
 * in memory for the page.
 */

export const SESSION_KEY = "nv.tsid";
export const SESSION_IDLE_MS = 30 * 60_000;
/** Refresh the idle clock at most this often, so tracking does not write storage per event. */
const TOUCH_EVERY_MS = 60_000;

export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 22 url-safe characters from 22 random bytes (64 divides 256, so no bias). */
export function randomId(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(22));
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

export class SessionId {
  private memory: { id: string; last: number } | null = null;

  constructor(
    private readonly store: SessionStore | null,
    private readonly random: (bytes: Uint8Array) => Uint8Array,
  ) {}

  private read(): { id: string; last: number } | null {
    if (this.store) {
      try {
        const raw = this.store.getItem(SESSION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { id?: unknown; last?: unknown };
          if (typeof parsed.id === "string" && /^[0-9A-Za-z_-]{16,64}$/.test(parsed.id) && typeof parsed.last === "number") return { id: parsed.id, last: parsed.last };
        }
      } catch {
        // Unreadable or blocked storage: fall back to memory.
      }
    }
    return this.memory;
  }

  private write(value: { id: string; last: number }): void {
    this.memory = value;
    if (!this.store) return;
    try {
      this.store.setItem(SESSION_KEY, JSON.stringify(value));
    } catch {
      // Quota or blocked storage: memory still holds it.
    }
  }

  /** Forgets the id in memory and in storage; the next `current()` starts a new one. */
  clear(): void {
    this.memory = null;
    if (!this.store) return;
    try {
      if (this.store.removeItem) this.store.removeItem(SESSION_KEY);
      else this.store.setItem(SESSION_KEY, "");
    } catch {
      // Blocked storage: nothing was kept there.
    }
  }

  /** The current id, starting a new session after 30 idle minutes. */
  current(now: number): string {
    const found = this.read();
    if (found && now - found.last < SESSION_IDLE_MS && now >= found.last) {
      if (now - found.last >= TOUCH_EVERY_MS) this.write({ id: found.id, last: now });
      return found.id;
    }
    const next = { id: randomId(this.random), last: now };
    this.write(next);
    return next.id;
  }
}
