import { useState, type FormEvent } from "react";
import { describeOutcome, isPlausibleEmail, normalizeCode, sendCode, verifyCode } from "@/pages/sign-in/model";
import { ConsoleError, request, SECOND_FACTOR, type ConsoleApi } from "./api";
import { Btn } from "./ui";

/**
 * What stands between a signed-out or not-yet-verified staff member and the console:
 * sign-in by emailed code, then the authenticator code (TOTP) for this session, or setting one
 * up the first time. Every non-student role needs TOTP (plan 2.3.10); the server enforces it,
 * this screen only asks for the code.
 */

export type GateKind = "signed_out" | "step_up" | "enroll";

export function Gate({ kind, api, onPassed }: { kind: GateKind; api: ConsoleApi; onPassed: () => void }) {
  return (
    <div className="cn-gate cn-card">
      {kind === "signed_out" ? <SignIn onPassed={onPassed} /> : kind === "step_up" ? <StepUp api={api} onPassed={onPassed} /> : <Enroll onPassed={onPassed} />}
    </div>
  );
}

function SignIn({ onPassed }: { onPassed: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = sent ? await verifyCode(email, code) : await sendCode(email);
    setBusy(false);
    if (!outcome.ok) return setError(describeOutcome(outcome, sent ? "code" : "email"));
    if (!sent) setSent(true);
    else onPassed();
  }

  return (
    <form className="cn-form" onSubmit={submit}>
      <h2>Curator sign-in</h2>
      <p className="cn-muted">Staff accounts only. You will also need your authenticator app.</p>
      <label className="cn-label">
        Email
        <input className="cn-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} required />
      </label>
      {sent ? (
        <label className="cn-label">
          Code from the email
          <input className="cn-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(normalizeCode(e.target.value))} required />
        </label>
      ) : null}
      {error ? <p className="cn-error" role="alert">{error}</p> : null}
      <Btn type="submit" primary disabled={busy || !isPlausibleEmail(email) || (sent && code.length < 6)}>
        {sent ? "Sign in" : "Email me a code"}
      </Btn>
    </form>
  );
}

function StepUp({ api, onPassed }: { api: ConsoleApi; onPassed: () => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (recovery) await api.secondFactorRecovery(code);
      else await api.secondFactorVerify(code);
      onPassed();
    } catch (err) {
      setError(err instanceof ConsoleError && err.status === 429 ? "Too many tries. Wait and try again." : "That code did not work. Use the current code from your app.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cn-form" onSubmit={submit}>
      <h2>Confirm it is you</h2>
      <p className="cn-muted">{recovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app."}</p>
      <label className="cn-label">
        {recovery ? "Recovery code" : "Authenticator code"}
        <input className="cn-input" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} value={code} onChange={(e) => setCode(e.target.value)} required />
      </label>
      {error ? <p className="cn-error" role="alert">{error}</p> : null}
      <div className="cn-actions">
        <Btn type="submit" primary disabled={busy || code.trim().length < 6}>
          Continue
        </Btn>
        <Btn onClick={() => setRecovery((r) => !r)}>{recovery ? "Use the app code" : "Use a recovery code"}</Btn>
      </div>
    </form>
  );
}

interface Enrollment {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

function Enroll({ onPassed }: { onPassed: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      setEnrollment(await request<Enrollment>(`${SECOND_FACTOR}/enroll`, { method: "POST", body: {} }));
    } catch {
      setError("Could not start the setup. An authenticator may already be set up: ask an admin to reset it.");
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await request(`${SECOND_FACTOR}/enroll/confirm`, { method: "POST", body: { code: code.replace(/\s/g, "") } });
      onPassed();
    } catch {
      setError("That code did not work. Check the time on your phone and try the current code.");
    }
  }

  if (!enrollment) {
    return (
      <div className="cn-form">
        <h2>Set up your authenticator</h2>
        <p className="cn-muted">Curator accounts need an authenticator app (TOTP) before the console opens.</p>
        {error ? <p className="cn-error" role="alert">{error}</p> : null}
        <Btn primary onClick={start}>
          Start setup
        </Btn>
      </div>
    );
  }
  return (
    <form className="cn-form" onSubmit={confirm}>
      <h2>Add Novus to your app</h2>
      <p className="cn-muted">Enter this key in your authenticator app (shown once):</p>
      <code className="cn-quote">{enrollment.secret}</code>
      <p className="cn-muted">Store these recovery codes offline. Each works once:</p>
      <pre className="cn-quote">{enrollment.recoveryCodes.join("\n")}</pre>
      <label className="cn-label">
        Code from the app
        <input className="cn-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      </label>
      {error ? <p className="cn-error" role="alert">{error}</p> : null}
      <Btn type="submit" primary disabled={code.trim().length < 6}>
        Confirm
      </Btn>
    </form>
  );
}
