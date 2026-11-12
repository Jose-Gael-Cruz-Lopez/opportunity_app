import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";
import { SelectField, TextField } from "@/components/forms/controls";
import { GlassPanel, PageShell } from "@/components/forms/surfaces";
import { appHref } from "@/components/forms/links";
import { todayIso } from "@/components/forms/dates";
import { api } from "@/lib/api";
import { readStoredDraft, storeDraft } from "../onboarding/data";
import { ageBand, birthYearOptions } from "../onboarding/model";
import {
  CODE_LENGTH,
  describeOutcome,
  destinationAfterSignIn,
  fetchTurnstileConfig,
  isPlausibleEmail,
  normalizeCode,
  sendCode,
  SEND_CODE_ACTION,
  turnstileMode,
  verifyCode,
  withTurnstileToken,
  type SignInStep,
  type TurnstileConfig,
} from "./model";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile";

/**
 * /app/sign-in: the age screen, then an emailed six-digit code. There are no passwords.
 * The age screen is skipped when onboarding already asked it on this device. Under 16, nothing is
 * sent and nothing is kept (the onboarding draft is cleared too). When the server has Turnstile on
 * (GET /api/v1/turnstile), every code send carries a fresh single-use token.
 */

const MONTH_OPTIONS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
  (label, i) => ({ value: String(i + 1), label }),
);

export default function SignInPage() {
  const today = todayIso();
  const search = useSearch();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const stored = readStoredDraft();
  const [birthMonth, setBirthMonth] = useState<number | null>(stored.birthMonth);
  const [birthYear, setBirthYear] = useState<number | null>(stored.birthYear);
  const [step, setStep] = useState<SignInStep>(stored.birthMonth !== null && stored.birthYear !== null ? "email" : "age");
  const [blocked, setBlocked] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [turnstile, setTurnstile] = useState<TurnstileConfig | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const widget = useRef<TurnstileHandle>(null);
  const mode = turnstileMode(turnstile);
  const needsToken = mode === "widget" && turnstileToken === null;

  useEffect(() => {
    headingRef.current?.focus();
  }, [step, blocked]);

  useEffect(() => {
    let live = true;
    void fetchTurnstileConfig().then((config) => {
      if (live) setTurnstile(config);
    });
    return () => {
      live = false;
    };
  }, []);

  const submitAge = (e: FormEvent) => {
    e.preventDefault();
    if (birthMonth === null || birthYear === null) {
      setError("Please choose your birth month and year to continue.");
      return;
    }
    setError(null);
    if (ageBand(birthYear, birthMonth, today) === "under_16") {
      storeDraft(null);
      setBlocked(true);
      return;
    }
    setStep("email");
  };

  const submitEmail = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!isPlausibleEmail(email)) {
      setError("Enter the email address you want to use, like name@example.com.");
      return;
    }
    if (mode === "unavailable") {
      setError("Sign-in is temporarily unavailable. Try again later.");
      return;
    }
    if (mode === "widget" && !turnstileToken) {
      setError("Complete the security check first.");
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await sendCode(email, turnstile && turnstileToken ? withTurnstileToken(turnstile.header, turnstileToken) : undefined);
    // Tokens are single-use: a fresh one is needed for the next send, whatever happened.
    widget.current?.reset();
    setBusy(false);
    if (!outcome.ok) {
      setError(describeOutcome(outcome, "email"));
      return;
    }
    if (step === "code") setResent(true);
    setStep("code");
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    const clean = normalizeCode(code);
    if (clean.length !== CODE_LENGTH) {
      setError(`The code has ${CODE_LENGTH} digits.`);
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await verifyCode(email, clean);
    if (!outcome.ok) {
      setBusy(false);
      setError(describeOutcome(outcome, "code"));
      return;
    }
    // Month and year only (never a full birthday); best effort, onboarding can save it later.
    if (birthMonth !== null && birthYear !== null) {
      const birthYearMonth = `${birthYear}-${String(birthMonth).padStart(2, "0")}`;
      await api.call("updateProfile", { body: { birthYearMonth } }).catch(() => undefined);
    }
    await qc.invalidateQueries({ queryKey: ["me"] });
    // New accounts start with the guided first five minutes (/app/start).
    const onboarded = await api
      .call("meSession")
      .then((r) => (r.user ? r.user.onboarded : null))
      .catch(() => null);
    setBusy(false);
    navigate(destinationAfterSignIn(search, onboarded));
  };

  if (blocked) {
    return (
      <Frame>
        <GlassPanel iris className="rounded-[34px] p-7">
          <h1 ref={headingRef} tabIndex={-1} className="nvp-h-lg outline-none">
            Thanks for stopping by
          </h1>
          <p className="mt-3 text-[16px] text-[color:var(--nvp-ink-2)]">
            Novus accounts are for students 16 and older, so nothing was sent or saved. You can still browse every program and its deadlines.
          </p>
          <Link href={appHref("/explore")} className="nvp-btn-go mt-6">
            Browse programs
          </Link>
        </GlassPanel>
      </Frame>
    );
  }

  return (
    <Frame>
      <GlassPanel iris className="rounded-[34px] p-6 sm:p-8">
        {step === "age" ? (
          <form onSubmit={submitAge} noValidate>
            <h1 ref={headingRef} tabIndex={-1} className="nvp-h-lg outline-none">
              Sign in to Novus
            </h1>
            <p className="mt-3 text-[15px] text-[color:var(--nvp-ink-2)]">First, your birth month and year. Novus never stores a full birthday.</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <SelectField label="Birth month" value={birthMonth === null ? null : String(birthMonth)} options={MONTH_OPTIONS} onChange={(v) => setBirthMonth(v === null ? null : Number(v))} />
              <SelectField
                label="Birth year"
                value={birthYear === null ? null : String(birthYear)}
                options={birthYearOptions(today).map((y) => ({ value: String(y), label: String(y) }))}
                onChange={(v) => setBirthYear(v === null ? null : Number(v))}
              />
            </div>
            <ErrorLine error={error} />
            <div className="mt-8 flex justify-end">
              <button type="submit" className="nvp-btn-go">
                Continue
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            </div>
          </form>
        ) : step === "email" ? (
          <form onSubmit={(e) => void submitEmail(e)} noValidate>
            <h1 ref={headingRef} tabIndex={-1} className="nvp-h-lg outline-none">
              Your email
            </h1>
            <p className="mt-3 text-[15px] text-[color:var(--nvp-ink-2)]">
              We will email you a {CODE_LENGTH}-digit code. A personal address works best, because school addresses often stop working after you graduate.
            </p>
            <div className="mt-6">
              <TextField label="Email address" type="email" inputMode="email" autoComplete="email" value={email} onChange={setEmail} placeholder="name@example.com" />
            </div>
            <TurnstileBlock mode={mode} config={turnstile} widgetRef={widget} onToken={setTurnstileToken} />
            <ErrorLine error={error} />
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <span />
              <button type="submit" className="nvp-btn-go" disabled={busy || needsToken || mode === "unavailable"}>
                {busy ? "Sending…" : "Email me a code"}
                {busy ? null : <ArrowRight size={18} aria-hidden="true" />}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={(e) => void submitCode(e)} noValidate>
            <h1 ref={headingRef} tabIndex={-1} className="nvp-h-lg outline-none">
              Check your email
            </h1>
            <p className="mt-3 text-[15px] text-[color:var(--nvp-ink-2)]" aria-live="polite">
              {resent ? "A new code is on its way" : "We sent a code"} to <strong>{email.trim()}</strong>. It expires in 10 minutes.
            </p>
            <div className="mt-6">
              <TextField
                label="Code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={CODE_LENGTH + 2}
                value={code}
                onChange={(v) => setCode(normalizeCode(v))}
                placeholder={"0".repeat(CODE_LENGTH)}
              />
            </div>
            {mode === "off" ? null : <TurnstileBlock mode={mode} config={turnstile} widgetRef={widget} onToken={setTurnstileToken} />}
            <ErrorLine error={error} />
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="nvp-btn"
                  onClick={() => {
                    setCode("");
                    setError(null);
                    setStep("email");
                  }}
                >
                  <ArrowLeft size={18} aria-hidden="true" />
                  Change email
                </button>
                <button type="button" className="nvp-btn" disabled={busy || needsToken || mode === "unavailable"} onClick={() => void submitEmail()}>
                  Send a new code
                </button>
              </div>
              <button type="submit" className="nvp-btn-go" disabled={busy}>
                {busy ? "Checking…" : "Sign in"}
              </button>
            </div>
          </form>
        )}
        <p className="nvp-meta mt-6 flex items-start gap-2" role="note">
          <Lock size={14} className="mt-0.5 flex-none" aria-hidden="true" />
          Novus only uses your email to sign you in and to send reminders you ask for.
        </p>
      </GlassPanel>
      <p className="nvp-meta mt-4 text-center">
        <Link href={appHref("/explore")}>Browse programs without an account</Link>
      </p>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      <div className="mx-auto max-w-xl py-6">{children}</div>
    </PageShell>
  );
}

function TurnstileBlock({
  mode,
  config,
  widgetRef,
  onToken,
}: {
  mode: ReturnType<typeof turnstileMode>;
  config: TurnstileConfig | null;
  widgetRef: React.RefObject<TurnstileHandle>;
  onToken: (token: string | null) => void;
}) {
  if (mode === "unavailable") {
    return (
      <p className="nvp-error mt-5" role="alert">
        Sign-in is temporarily unavailable. Try again later.
      </p>
    );
  }
  if (mode !== "widget" || !config?.siteKey) return null;
  return <TurnstileWidget ref={widgetRef} siteKey={config.siteKey} action={SEND_CODE_ACTION} onToken={onToken} />;
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="nvp-error mt-5" role="alert">
      {error}
    </p>
  ) : null;
}
