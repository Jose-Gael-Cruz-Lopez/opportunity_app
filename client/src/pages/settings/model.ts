import type { ConsentKind, ConsentRecord } from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { LOOK_STORAGE_KEY, SOLID_STORAGE_KEY } from "@/design/look";
import { PREFS_STORAGE_KEY } from "@/components/forms/prefs";

/**
 * Settings and privacy: what Novus keeps, what stays on the device, and the rules for consent
 * and deletion. The inventory is plain data so the page and its tests read the same list.
 */

export interface InventoryRow {
  readonly what: string;
  readonly why: string;
}

/** Stored by Novus on its servers when you have an account. */
export const STORED_ON_NOVUS: readonly InventoryRow[] = [
  { what: "Email address and sign-in sessions", why: "To sign you in and send the reminders you ask for." },
  { what: "Profile: class year, graduation term, institution, field of study, GPA band, state, interests", why: "To find programs that fit and lay out your roadmap." },
  { what: "Programs you track, pin or dismiss, and your checklist progress", why: "To show your tracker and roadmap on any device." },
  { what: "Notification and calendar settings", why: "To send email at the times you chose." },
  { what: "Consents you have given, with the date", why: "So you can see and revoke each one." },
  { what: "Questions you ask Novus (when the assistant is on)", why: "Sent to the AI service with public program sources to answer them. Your private answers are never included." },
];

/** Kept only in this browser. */
export const STAYS_ON_DEVICE: readonly InventoryRow[] = [
  {
    what: "Private eligibility answers: citizenship or immigration status, income and Pell, first-generation status, identity, disability, veteran and foster-care status",
    why: `Checked against program rules in this browser only. Held in memory, cleared when you close the tab or after ${PRODUCT.sensitiveIdleClearMinutes} idle minutes.`,
  },
  { what: "Look, solid surfaces, reduced motion and the AI switch", why: "Display choices for this browser." },
  { what: "An unfinished onboarding draft", why: "So you can pick up where you left off on this device." },
];

/** Never collected anywhere. */
export const NEVER_COLLECTED: readonly string[] = [
  "Your full date of birth (only month and year, for age limits)",
  "Private eligibility answers on any server, log, analytics event or AI prompt",
  "Tracking pixels in email",
  "A score or percentage about you",
];

export const DELETION_COPY =
  "Deleted data is removed from live systems within 3 days and from all backups within 40 days of your request.";

export const DELETE_CONFIRM_WORD = "DELETE";

/** The confirm field must spell the word exactly (case-insensitive, spaces trimmed). */
export function deleteConfirmed(text: string): boolean {
  return text.trim().toUpperCase() === DELETE_CONFIRM_WORD;
}

export const CONSENT_LABELS: Record<ConsentKind, { title: string; detail: string }> = {
  sensitive_tracking: {
    title: "Save status-based programs to your account",
    detail: "Programs whose eligibility depends on a status (for example, citizenship) can be saved to your tracker.",
  },
  identity_tracking: {
    title: "Save identity-based programs to your account",
    detail: "Programs for a specific community can be saved to your tracker and roadmap.",
  },
  health_tracking: { title: "Save health-related programs to your account", detail: "Programs for students with a disability or health condition." },
  analytics: { title: "Product analytics", detail: "Counts of page views and features used, with no private answers." },
  minor_outcomes: { title: "Outcome reports while under 18", detail: "Lets you report results while you are 16 or 17." },
  advisor_scope: { title: "Share with your advisor", detail: "Your advisor can see the programs you track." },
  derived_results: { title: "Save checked results", detail: "Keeps the result of an eligibility check, never the answers behind it." },
  school_email_alerts: { title: "Alerts to your school email", detail: "Sends reminders to your school address as well." },
};

/**
 * Consents currently in force: one row per kind and program, the newest grant wins, and rows
 * with a revocation are left out.
 */
export function activeConsents(records: readonly ConsentRecord[]): ConsentRecord[] {
  const latest = new Map<string, ConsentRecord>();
  for (const r of records) {
    const key = `${r.kind}|${r.programId ?? ""}`;
    const prev = latest.get(key);
    if (!prev || prev.grantedAt < r.grantedAt) latest.set(key, r);
  }
  return [...latest.values()].filter((r) => r.revokedAt === null).sort((a, b) => a.kind.localeCompare(b.kind) || b.grantedAt.localeCompare(a.grantedAt));
}

/** Name of the browser event other modules listen to, to clear in-memory private answers. */
export const CLEAR_PRIVATE_ANSWERS_EVENT = "novus:clear-sensitive-answers";

/** Local keys this app owns; "Reset this device" removes exactly these. */
export const DEVICE_STORAGE_KEYS = [PREFS_STORAGE_KEY, LOOK_STORAGE_KEY, SOLID_STORAGE_KEY, "novus-onboarding-draft-v1"] as const;
