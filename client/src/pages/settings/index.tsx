import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HardDrive, Laptop, LogOut, Palette, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type { ConsentRecord } from "@shared/contracts";
import { ChoiceChips, SwitchRow } from "@/components/forms/controls";
import { GlassPanel, PageShell } from "@/components/forms/surfaces";
import { usePrefs } from "@/components/forms/prefs";
import { appHref } from "@/components/forms/links";
import { useLookPrefs } from "@/components/forms/look";
import type { Look } from "@/design";
import { SIGN_OUT_FAILED_COPY, useSignOut } from "@/lib/sign-out";
import { callRoute, isApiUnreachable, isUnauthenticated, useAccountSession } from "@/components/forms/request";
import {
  CLEAR_PRIVATE_ANSWERS_EVENT,
  CONSENT_LABELS,
  DELETE_CONFIRM_WORD,
  DELETION_COPY,
  DEVICE_STORAGE_KEYS,
  NEVER_COLLECTED,
  STAYS_ON_DEVICE,
  STORED_ON_NOVUS,
  activeConsents,
  deleteConfirmed,
  type InventoryRow,
} from "./model";

/**
 * Settings and privacy: the look of the app on this device, the AI switch, a plain inventory of
 * what Novus stores and what stays on the device, consents with one-tap revocation, and data
 * export and deletion requests.
 */

/**
 * The phone account menu links to "/settings#inventory-title" (privacy). The shell scrolls to the
 * top on every route change, so the jump waits a frame to run after it.
 */
function useScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, []);
}

export default function SettingsPage() {
  useScrollToHash();
  return (
    <PageShell labelledBy="settings-title">
      <header className="mb-6">
        <h1 id="settings-title" className="nvp-h-lg">
          Settings and privacy
        </h1>
        <p className="nvp-meta mt-1">What Novus keeps, what stays on this device, and how to take it all back.</p>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <LookSection />
        <AiSection />
        <div className="lg:col-span-2">
          <InventorySection />
        </div>
        <ConsentSection />
        <DataSection />
      </div>
    </PageShell>
  );
}

function Section({ id, icon, title, children, className }: { id: string; icon: ReactNode; title: string; children: ReactNode; className?: string }) {
  return (
    <GlassPanel aria-labelledby={id} className={`rounded-[28px] p-5 sm:p-6 ${className ?? ""}`}>
      <h2 id={id} className="mb-3 flex items-center gap-2.5 text-[19px] font-semibold">
        <span aria-hidden="true" className="nvp-stat-ring !h-9 !w-9">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </GlassPanel>
  );
}

const LOOK_OPTIONS = [
  { value: "ember" as Look, label: "Ember", hint: "Warm clay and sand" },
  { value: "meadow" as Look, label: "Meadow", hint: "Olive, sage and cream" },
];

function LookSection() {
  const [prefs, setPrefs] = usePrefs();
  const looks = useLookPrefs();
  return (
    <Section id="look-title" icon={<Palette size={17} />} title="Look on this device">
      <ChoiceChips legend="Colour look" options={LOOK_OPTIONS} value={[looks.look]} onChange={([v]) => v && looks.setLook(v)} />
      <div className="mt-3 divide-y divide-[color:var(--nvp-line)]">
        <SwitchRow
          label="Solid surfaces"
          description="Replaces frosted glass with solid panels. Easier to read on older phones and in bright light."
          checked={looks.solid}
          onChange={looks.setSolid}
        />
        <SwitchRow
          label="Reduce motion"
          description="Stops the breathing orb and slide-in effects. Your system setting is always respected too."
          checked={prefs.reduceMotion}
          onChange={(v) => setPrefs({ reduceMotion: v })}
        />
      </div>
    </Section>
  );
}

function AiSection() {
  const [prefs, setPrefs] = usePrefs();
  return (
    <Section id="ai-title" icon={<Sparkles size={17} />} title="AI assistant">
      <SwitchRow
        label="Use the AI assistant"
        description={
          prefs.aiAssistant
            ? "On. Ask Novus and readiness explanations may use Google Gemini to explain things in plain words."
            : "Off. This device never sends anything to the assistant. Nothing else changes."
        }
        checked={prefs.aiAssistant}
        onChange={(v) => setPrefs({ aiAssistant: v })}
      />
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[14px] text-[color:var(--nvp-ink-2)]">
        <li>Eligibility, requirements, competitiveness bands and dates are decided by fixed rules, never by the AI.</li>
        <li>The AI sees your question and public program sources. It never sees your private eligibility answers.</li>
        <li>Every AI answer cites its sources. If a quote does not match its source, Novus does not show it.</li>
        <li>If the server has no AI key, answers come from a plain search of Novus records, and the page says so.</li>
      </ul>
    </Section>
  );
}

function InventoryList({ rows }: { rows: readonly InventoryRow[] }) {
  return (
    <dl className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.what} className="nvp-inset px-4 py-3">
          <dt className="text-[15px] font-semibold">{r.what}</dt>
          <dd className="mt-0.5 text-[14px] text-[color:var(--nvp-ink-3)]">{r.why}</dd>
        </div>
      ))}
    </dl>
  );
}

function InventorySection() {
  const [cleared, setCleared] = useState<string | null>(null);
  const clearPrivate = () => {
    window.dispatchEvent(new CustomEvent(CLEAR_PRIVATE_ANSWERS_EVENT));
    setCleared("Private answers on this device were cleared.");
  };
  const resetDevice = () => {
    for (const key of DEVICE_STORAGE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Storage may be blocked; there is then nothing stored to remove.
      }
    }
    window.dispatchEvent(new CustomEvent(CLEAR_PRIVATE_ANSWERS_EVENT));
    setCleared("This device's Novus settings and drafts were removed. Reload to see the defaults.");
  };
  return (
    <Section id="inventory-title" icon={<ShieldCheck size={17} />} title="What Novus keeps">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="nvp-label mb-3 flex items-center gap-2">
            <HardDrive size={14} aria-hidden="true" /> Stored on Novus
          </h3>
          <InventoryList rows={STORED_ON_NOVUS} />
        </div>
        <div>
          <h3 className="nvp-label mb-3 flex items-center gap-2">
            <Laptop size={14} aria-hidden="true" /> Stays on this device
          </h3>
          <InventoryList rows={STAYS_ON_DEVICE} />
          <h3 className="nvp-label mb-2 mt-5">Never collected</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] text-[color:var(--nvp-ink-2)]">
            {NEVER_COLLECTED.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="nvp-btn" onClick={clearPrivate}>
              Clear my private answers
            </button>
            <button type="button" className="nvp-btn" onClick={resetDevice}>
              Reset this device
            </button>
          </div>
          <p className="nvp-meta mt-2" role="status" aria-live="polite">
            {cleared ?? ""}
          </p>
        </div>
      </div>
    </Section>
  );
}

type Availability = "live" | "signed_out" | "no_api" | "loading" | "error";

function availability(q: { isPending: boolean; isSuccess: boolean; error: unknown }): Availability {
  if (q.isPending) return "loading";
  if (q.isSuccess) return "live";
  if (isUnauthenticated(q.error)) return "signed_out";
  if (isApiUnreachable(q.error)) return "no_api";
  return "error";
}

function AccountNotice({ state }: { state: Exclude<Availability, "live" | "loading"> }) {
  const words = {
    signed_out: "Sign in to see and change what your account stores.",
    no_api: "The Novus API is not connected, so account data cannot be shown here.",
    error: "Your account data did not load. Try again later.",
  } as const;
  return (
    <p className="mb-4 text-[14.5px] text-[color:var(--nvp-ink-2)]">
      {words[state]}{" "}
      {state === "signed_out" ? (
        <Link href={appHref("/sign-in?next=/settings")} className="underline underline-offset-2">
          Sign in
        </Link>
      ) : null}
    </p>
  );
}

function ConsentSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["me", "consents"], queryFn: ({ signal }) => callRoute("listConsents", { signal }), retry: false });
  const revoke = useMutation({
    mutationFn: (c: ConsentRecord) => callRoute("changeConsent", { body: { kind: c.kind, textVersion: c.textVersion, programId: c.programId, granted: false } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "consents"] }),
  });
  const state = availability(q);
  const active = q.data ? activeConsents(q.data.items) : [];
  return (
    <Section id="consent-title" icon={<ShieldCheck size={17} />} title="Consents">
      {state === "loading" ? <p className="nvp-meta">Loading…</p> : null}
      {state !== "live" && state !== "loading" ? <AccountNotice state={state} /> : null}
      {state === "live" && active.length === 0 ? <p className="text-[14.5px] text-[color:var(--nvp-ink-2)]">You have not given any optional consents.</p> : null}
      {active.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {active.map((c) => {
            const label = CONSENT_LABELS[c.kind];
            return (
              <li key={`${c.kind}-${c.programId ?? "all"}`} className="nvp-inset flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold">{label.title}</p>
                  <p className="text-[13.5px] text-[color:var(--nvp-ink-3)]">{label.detail}</p>
                  <p className="nvp-meta">Given {c.grantedAt.slice(0, 10)}</p>
                </div>
                <button type="button" className="nvp-btn" disabled={revoke.isPending} onClick={() => revoke.mutate(c)}>
                  Stop saving these on Novus
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {revoke.isError ? (
        <p className="nvp-error mt-2" role="alert">
          The consent was not revoked. Try again.
        </p>
      ) : null}
    </Section>
  );
}

/** Ending the session on a shared or library computer. */
function SignOutBlock() {
  const exit = useSignOut();
  return (
    <div>
      <h3 className="text-[15.5px] font-semibold">Sign out</h3>
      <p className="mt-1 text-[14px] text-[color:var(--nvp-ink-3)]">
        Ends your session on this device and clears private answers from this tab. Use it on a shared or library computer.
      </p>
      <button type="button" className="nvp-btn mt-3" disabled={exit.pending} onClick={() => void exit.signOut()}>
        <LogOut size={16} aria-hidden="true" />
        {exit.pending ? "Signing out…" : "Sign out of Novus"}
      </button>
      <p className="nvp-meta mt-2" role="status" aria-live="polite">
        {exit.failed ? SIGN_OUT_FAILED_COPY : ""}
      </p>
    </div>
  );
}

function DataSection() {
  const confirmId = useId();
  const session = useAccountSession();
  const signedIn = Boolean(session.data?.session?.user);
  const exportM = useMutation({ mutationFn: () => callRoute("exportData", { body: {} }) });
  const deleteM = useMutation({ mutationFn: () => callRoute("deleteAccount") });
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const state: Availability = session.isPending
    ? "loading"
    : signedIn
      ? "live"
      : session.data?.sample
        ? "no_api"
        : session.isSuccess
          ? "signed_out"
          : availability(session);

  return (
    <Section id="data-title" icon={<Download size={17} />} title="Your data">
      {state !== "live" && state !== "loading" ? <AccountNotice state={state} /> : null}
      <div className="flex flex-col gap-5">
        {signedIn ? <SignOutBlock /> : null}
        <div className={signedIn ? "border-t border-[color:var(--nvp-line)] pt-5" : undefined}>
          <h3 className="text-[15.5px] font-semibold">Download a copy</h3>
          <p className="mt-1 text-[14px] text-[color:var(--nvp-ink-3)]">
            A JSON file of everything your account stores, plus a CSV of tracked programs. We email you a code and a single-use link that works for 1
            hour.
          </p>
          <button type="button" className="nvp-btn mt-3" disabled={!signedIn || exportM.isPending || exportM.isSuccess} onClick={() => exportM.mutate()}>
            <Download size={16} aria-hidden="true" />
            {exportM.isSuccess ? "Export requested" : "Request my data"}
          </button>
          <p className="nvp-meta mt-2" role="status" aria-live="polite">
            {exportM.isSuccess ? "Check your email for the link." : exportM.isError ? "The request did not go through. Try again." : ""}
          </p>
        </div>

        <div className="border-t border-[color:var(--nvp-line)] pt-5">
          <h3 className="text-[15.5px] font-semibold">Delete my account</h3>
          <p className="mt-1 text-[14px] text-[color:var(--nvp-ink-3)]">
            Your account is hidden at once and you get an email with an undo link that works for 48 hours. {DELETION_COPY}
          </p>
          {deleteM.isSuccess ? (
            <p className="mt-3 text-[14.5px]" role="status">
              Your account is scheduled for deletion. Check your email if you change your mind.
            </p>
          ) : !confirming ? (
            <button type="button" className="nvp-btn nvp-btn-danger mt-3" disabled={!signedIn} onClick={() => setConfirming(true)}>
              <Trash2 size={16} aria-hidden="true" />
              Delete my account
            </button>
          ) : (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (deleteConfirmed(confirmText)) deleteM.mutate();
              }}
            >
              <label htmlFor={confirmId} className="text-[14.5px]">
                Type {DELETE_CONFIRM_WORD} to confirm
              </label>
              <input id={confirmId} className="nvp-input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" autoFocus />
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="nvp-btn nvp-btn-danger" disabled={!deleteConfirmed(confirmText) || deleteM.isPending}>
                  Delete my account
                </button>
                <button
                  type="button"
                  className="nvp-btn"
                  onClick={() => {
                    setConfirming(false);
                    setConfirmText("");
                  }}
                >
                  Cancel
                </button>
              </div>
              {deleteM.isError ? (
                <p className="nvp-error" role="alert">
                  The request did not go through. Nothing was deleted.
                </p>
              ) : null}
            </form>
          )}
        </div>
      </div>
    </Section>
  );
}
