import { useMemo } from "react";
import { Link } from "wouter";
import { appPaths, signInThenReturn } from "@/lib/routes";
import { DraftKeep } from "./door-panels";
import type { PlanStepView } from "./normalize";
import { Glass, Kicker, Note } from "./ui";
import { shortDate } from "./wording";

/**
 * Where "Save your plan" and "Go to my dashboard" go. They are wouter paths relative to the
 * <Router base="/app">, not hash links: the app uses path routing and nothing listens for
 * hashchange, so a "#/..." link only changed the fragment and left the student here.
 */
export const SAVE_INTENT_PARAM = "save";
/**
 * Signed out, "Save your plan" goes through sign-in and back to /start with `?save=1`; the start
 * page then reopens the done screen and saves the plan by itself (pages/start/index.tsx).
 */
export const SIGN_UP_HREF = signInThenReturn(`${appPaths.start}?${SAVE_INTENT_PARAM}=1`);
export const HOME_HREF = appPaths.home;

/** True when the URL asks the start page to finish a save started before sign-in. */
export function hasSaveIntent(search: string): boolean {
  return new URLSearchParams(search).get(SAVE_INTENT_PARAM) === "1";
}

/** The same search string without the save intent, so a reload does not save again. */
export function withoutSaveIntent(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SAVE_INTENT_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export type SaveState = "idle" | "saving" | "saved" | "device" | "failed";

/**
 * The celebration: progress already made (endowed progress), the next step's date, the
 * official application, and a soft sign-up wall to keep the plan.
 */
export function DoneStep({
  programName,
  applyUrl,
  doneCount,
  total,
  next,
  saveState,
  signedIn,
  onSave,
  onForget,
  draft,
  keepDraft,
  setKeepDraft,
}: {
  programName: string;
  applyUrl: string;
  doneCount: number;
  total: number;
  next: PlanStepView | null;
  saveState: SaveState;
  signedIn: boolean;
  onSave: () => void;
  onForget: () => void;
  /** The "Why this program?" draft from the door screen, shown again so it is not lost. */
  draft: string;
  keepDraft: boolean;
  setKeepDraft: (v: boolean) => void;
}) {
  // Fixed positions and colours so the confetti is deterministic (and hidden for reduced motion).
  const confetti = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        left: `${(i * 37) % 100}%`,
        delay: `${(i % 7) * 0.12}s`,
        color: ["#F6BE78", "#AECBD0", "#FFF4E4", "#E88C3A", "#D3E5B6"][i % 5],
      })),
    [],
  );

  return (
    <Glass className="st-enter st-celebrate" aria-labelledby="st-done-title">
      <div className="st-confetti" aria-hidden="true">
        {confetti.map((c, i) => (
          <i key={i} style={{ left: c.left, animationDelay: c.delay, background: c.color }} />
        ))}
      </div>
      <Kicker>Your first door is open</Kicker>
      <h1 id="st-done-title" className="st-h1">
        You've started your first application.
      </h1>
      <p className="st-lede">{programName}</p>
      <p style={{ marginTop: 22 }} aria-label={`${doneCount} of ${total} steps done`}>
        <span className="st-dot st-num" style={{ fontSize: 72 }}>
          {doneCount}/{total}
        </span>
        <span className="st-meta" style={{ display: "block", marginTop: 6 }}>
          steps done
        </span>
      </p>
      {next && (
        <p className="st-lede st-small" style={{ marginTop: 14 }}>
          Next: {next.title}
          {next.due ? `, by ${shortDate(next.due)}` : ""}.
        </p>
      )}

      <div className="st-actions" style={{ justifyContent: "center" }}>
        <a className="st-btn st-btn-go" href={applyUrl} target="_blank" rel="noopener noreferrer">
          Open the official application
        </a>
        {signedIn ? (
          <button type="button" className="st-btn st-btn-cream" onClick={onSave} disabled={saveState === "saving" || saveState === "saved"}>
            {saveState === "saved" ? "Saved to your Tracker" : saveState === "saving" ? "Saving…" : "Save my plan"}
          </button>
        ) : (
          <Link className="st-btn st-btn-cream" href={SIGN_UP_HREF}>
            Sign in to save your plan
          </Link>
        )}
      </div>

      <div aria-live="polite" style={{ marginTop: 16, textAlign: "left" }}>
        {saveState === "saved" && <Note>Saved to your Tracker. Your reminders and calendar feed follow it from here.</Note>}
        {saveState === "device" && <Note>Kept on this device for now. Create an account to get reminders and keep it everywhere.</Note>}
        {saveState === "failed" && <Note tone="warn">Couldn't save to your account just now, so it stays on this device. Try again later.</Note>}
        {!signedIn && saveState === "idle" && (
          <Note>
            Your plan is on this device. A free account keeps it, sends your reminders, and adds the deadline to your calendar feed. After you sign in,
            Novus brings you back here and saves it.
            {draft.trim() && !keepDraft ? " Your opening draft isn't kept through sign-in unless you keep it on this device below." : ""}
          </Note>
        )}
      </div>

      {draft.trim() && (
        <div className="st-stack" style={{ marginTop: 18, textAlign: "left" }}>
          <h2 className="st-h3">Your opening for "Why this program?"</h2>
          <blockquote className="st-quote">{draft}</blockquote>
          <DraftKeep programName={programName} text={draft} keepOnDevice={keepDraft} setKeepOnDevice={setKeepDraft} />
        </div>
      )}

      <div className="st-actions" style={{ justifyContent: "center" }}>
        <Link className="st-btn st-btn-ghost" href={HOME_HREF}>
          Go to my dashboard
        </Link>
        <button type="button" className="st-btn st-btn-ghost" onClick={onForget}>
          Forget this on my device
        </button>
      </div>
    </Glass>
  );
}
