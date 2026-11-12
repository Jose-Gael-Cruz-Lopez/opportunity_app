import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowRight, Lock, Plus, X } from "lucide-react";
import { CLASS_YEAR_LABELS, MAJOR_FAMILY_LABELS } from "@shared/contracts";
import { ChoiceChips, SelectField, StepProgress, SwitchRow } from "@/components/forms/controls";
import { GlassPanel, PageShell, SampleNotice } from "@/components/forms/surfaces";
import { useLookPrefs } from "@/components/forms/look";
import { appHref } from "@/components/forms/links";
import { todayIso } from "@/components/forms/dates";
import { blockTelemetryForUnderAge } from "@/lib/telemetry";
import { readStoredDraft, storeDraft, useSaveProfile, useSavedProfile, type SaveOutcome } from "./data";
import {
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  CLASS_YEAR_OPTIONS,
  EXPERIENCE_OPTIONS,
  GPA_OPTIONS,
  INSTITUTION_LEVEL_OPTIONS,
  INTEREST_SUGGESTIONS,
  MAJOR_FAMILY_OPTIONS,
  PREP_HOURS_OPTIONS,
  STEPS,
  STEP_TITLES,
  TRANSFER_INTENT_OPTIONS,
  ageBand,
  birthYearOptions,
  checkTag,
  draftFromProfile,
  graduationTermOptions,
  isDraftEmpty,
  missingFor,
  nextStep,
  previousStep,
  stepIndex,
  type Draft,
  type Step,
} from "./model";

/**
 * Onboarding: five short steps that fill the non-sensitive profile (age, class year, field,
 * interests). It works signed out: the draft stays on this device until the student signs in.
 * There are no status or identity questions here; program pages ask those on the device.
 */

const MONTH_OPTIONS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
  (label, i) => ({ value: String(i + 1), label }),
);

export default function OnboardingPage() {
  const today = todayIso();
  const [draft, setDraft] = useState<Draft>(() => readStoredDraft());
  const [step, setStep] = useState<Step>("age");
  const [showMissing, setShowMissing] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const saved = useSavedProfile();
  const save = useSaveProfile();

  // Prefill from a saved profile once, when this device has no draft of its own.
  const profile = saved.profile;
  useEffect(() => {
    // Runs only when the profile arrives; later draft edits must not be overwritten.
    if (profile && isDraftEmpty(draft)) setDraft(draftFromProfile(profile));
  }, [profile]);

  useEffect(() => {
    if (!blocked) storeDraft(draft);
  }, [draft, blocked]);

  // Move focus to the new step's heading so keyboard and screen-reader users land in context.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step, outcome, blocked]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const missing = missingFor(step, draft);

  const goNext = (e?: FormEvent) => {
    e?.preventDefault();
    if (missing.length > 0) {
      setShowMissing(true);
      return;
    }
    setShowMissing(false);
    if (step === "age" && draft.birthYear !== null && draft.birthMonth !== null && ageBand(draft.birthYear, draft.birthMonth, today) === "under_16") {
      // Under 16: no account and nothing kept, not even the draft. Analytics stay off for the
      // rest of this tab (plan 9.10.2): the queue is dropped and the telemetry session id and
      // error counter are forgotten, so later page views cannot join what came before.
      storeDraft(null);
      blockTelemetryForUnderAge();
      setBlocked(true);
      return;
    }
    if (step === "review") {
      save.mutate(draft, {
        onSuccess: (result) => {
          setOutcome(result);
          if (result === "saved") storeDraft(null);
        },
      });
      return;
    }
    setStep(nextStep(step));
  };

  if (blocked) {
    return (
      <Frame>
        <GlassPanel iris className="rounded-[34px] p-7">
          <h1 ref={headingRef} tabIndex={-1} className="nvp-h-lg outline-none">
            Thanks for stopping by
          </h1>
          <p className="mt-3 text-[16px] text-[color:var(--nvp-ink-2)]">
            Novus accounts are for students 16 and older, so we have not saved anything you entered. You can still browse every program and its deadlines.
          </p>
          <Link href={appHref("/explore")} className="nvp-btn-go mt-6">
            Browse programs
          </Link>
        </GlassPanel>
      </Frame>
    );
  }

  if (outcome) {
    return (
      <Frame>
        <GlassPanel iris className="rounded-[34px] p-7">
          <h1 ref={headingRef} tabIndex={-1} className="nvp-h-lg outline-none">
            {outcome === "saved" ? "You're set" : "Almost there"}
          </h1>
          {outcome === "saved" ? (
            <p className="mt-3 text-[16px] text-[color:var(--nvp-ink-2)]">Your profile is saved. Your roadmap and matches now use it.</p>
          ) : outcome === "signed_out" ? (
            <p className="mt-3 text-[16px] text-[color:var(--nvp-ink-2)]">
              Sign in with your email to save this profile. Until then your answers stay on this device only.
            </p>
          ) : (
            <SampleNotice>The Novus API is not connected, so your answers are kept on this device only.</SampleNotice>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {outcome === "signed_out" ? (
              <Link href={appHref("/sign-in?next=/onboarding")} className="nvp-btn-go">
                Sign in to save
              </Link>
            ) : null}
            <Link href={appHref("/roadmap")} className={outcome === "signed_out" ? "nvp-btn" : "nvp-btn-go"}>
              See my roadmap
            </Link>
            <Link href={appHref("/explore")} className="nvp-btn">
              Explore programs
            </Link>
          </div>
        </GlassPanel>
      </Frame>
    );
  }

  const index = stepIndex(step);
  return (
    <Frame>
      <h1 className="sr-only">Set up your Novus profile</h1>
      <StepProgress step={index + 1} total={STEPS.length} label={STEP_TITLES[step]} />
      <form onSubmit={goNext} noValidate className="mt-5">
        <GlassPanel iris className="rounded-[34px] p-6 sm:p-8">
          <h2 ref={headingRef} tabIndex={-1} className="mb-6 text-[clamp(24px,3vw,32px)] font-semibold leading-tight tracking-[-0.02em] outline-none">
            {STEP_HEADINGS[step]}
          </h2>
          <div className="flex flex-col gap-6">
            {step === "age" ? <AgeStep draft={draft} update={update} today={today} /> : null}
            {step === "year" ? <YearStep draft={draft} update={update} today={today} /> : null}
            {step === "study" ? <StudyStep draft={draft} update={update} /> : null}
            {step === "interests" ? <InterestsStep draft={draft} update={update} /> : null}
            {step === "review" ? <ReviewStep draft={draft} goTo={setStep} /> : null}
          </div>
          {showMissing && missing.length > 0 ? (
            <p className="nvp-error mt-5" role="alert">
              Please choose your {missing.join(", ")} to continue.
            </p>
          ) : null}
          {save.isError ? (
            <p className="nvp-error mt-5" role="alert">
              Your profile was not saved. {save.error instanceof Error ? save.error.message : ""} Try again.
            </p>
          ) : null}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            {index > 0 ? (
              <button type="button" className="nvp-btn" onClick={() => setStep(previousStep(step))}>
                <ArrowLeft size={18} aria-hidden="true" />
                Back
              </button>
            ) : (
              <span />
            )}
            <button type="submit" className="nvp-btn-go" disabled={save.isPending}>
              {step === "review" ? (save.isPending ? "Saving…" : "Save my profile") : "Continue"}
              {step !== "review" ? <ArrowRight size={18} aria-hidden="true" /> : null}
            </button>
          </div>
        </GlassPanel>
      </form>
      <PrivacyNote />
    </Frame>
  );
}

const STEP_HEADINGS: Record<Step, string> = {
  age: "When were you born?",
  year: "Where are you in school?",
  study: "What do you study?",
  interests: "What are you looking for?",
  review: "Does this look right?",
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      <div className="mx-auto max-w-2xl">{children}</div>
    </PageShell>
  );
}

function PrivacyNote() {
  return (
    <p className="nvp-meta mt-5 flex items-start gap-2" role="note">
      <Lock size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      Novus never asks here about citizenship, income, first-generation status or identity. When a program depends on one of those, its page asks you
      privately and the answer stays on this device.
    </p>
  );
}

type StepProps = { draft: Draft; update: (patch: Partial<Draft>) => void };

function AgeStep({ draft, update, today }: StepProps & { today: string }) {
  return (
    <>
      <p className="text-[15px] text-[color:var(--nvp-ink-2)]">Month and year only. Some programs have age limits, and Novus never stores your full birthday.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Birth month"
          value={draft.birthMonth === null ? null : String(draft.birthMonth)}
          options={MONTH_OPTIONS}
          onChange={(v) => update({ birthMonth: v === null ? null : Number(v) })}
        />
        <SelectField
          label="Birth year"
          value={draft.birthYear === null ? null : String(draft.birthYear)}
          options={birthYearOptions(today).map((y) => ({ value: String(y), label: String(y) }))}
          onChange={(v) => update({ birthYear: v === null ? null : Number(v) })}
        />
      </div>
    </>
  );
}

function YearStep({ draft, update, today }: StepProps & { today: string }) {
  return (
    <>
      <ChoiceChips legend="Class year" options={CLASS_YEAR_OPTIONS} value={draft.classYear ? [draft.classYear] : []} onChange={([v]) => update({ classYear: v ?? null })} />
      <SelectField
        label="When do you expect to graduate? (optional)"
        hint="A guess is fine. It sets how many years your roadmap covers."
        value={draft.graduationTerm}
        options={graduationTermOptions(today)}
        onChange={(v) => update({ graduationTerm: v })}
        placeholder="Not sure yet"
      />
      <ChoiceChips
        legend="Your school (optional)"
        options={INSTITUTION_LEVEL_OPTIONS}
        value={draft.institutionLevel ? [draft.institutionLevel] : []}
        onChange={([v]) => update({ institutionLevel: v ?? null })}
      />
      {draft.institutionLevel === "two_year" ? (
        <ChoiceChips
          legend="Do you plan to transfer to a four-year school? (optional)"
          options={TRANSFER_INTENT_OPTIONS}
          value={draft.transferIntent ? [draft.transferIntent] : []}
          onChange={([v]) => update({ transferIntent: v ?? null })}
        />
      ) : null}
    </>
  );
}

function StudyStep({ draft, update }: StepProps) {
  return (
    <>
      <ChoiceChips
        legend="Field of study"
        options={MAJOR_FAMILY_OPTIONS}
        value={draft.majorFamily ? [draft.majorFamily] : []}
        onChange={([v]) => update({ majorFamily: v ?? null })}
      />
      <SelectField
        label="GPA (optional)"
        hint="Some programs set a minimum. Novus uses a range, never the exact number."
        value={draft.gpaBand}
        options={GPA_OPTIONS}
        onChange={(v) => update({ gpaBand: v })}
        placeholder="Skip for now"
      />
    </>
  );
}

function InterestsStep({ draft, update }: StepProps) {
  const looks = useLookPrefs();
  const [tagDraft, setTagDraft] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const addTag = (raw: string) => {
    const r = checkTag(raw);
    if (!r.ok) {
      setTagError(
        r.reason === "sensitive"
          ? "That looks like a personal status or identity detail. Novus keeps those on your device, so it is not added to your profile."
          : r.reason === "length"
            ? "Use 2 to 40 characters."
            : "Use letters, numbers and spaces.",
      );
      return;
    }
    setTagError(null);
    setTagDraft("");
    if (!draft.interestTags.includes(r.tag) && draft.interestTags.length < 30) update({ interestTags: [...draft.interestTags, r.tag] });
  };
  return (
    <>
      <ChoiceChips legend="Kinds of opportunity" options={CATEGORY_OPTIONS} value={draft.categories} onChange={(v) => update({ categories: v })} multiple />
      <fieldset>
        <legend className="nvp-label mb-3">Topics you care about (optional)</legend>
        <div className="flex flex-wrap gap-2">
          {INTEREST_SUGGESTIONS.filter((t) => !draft.interestTags.includes(t)).map((t) => (
            <button key={t} type="button" className="nvp-chip" onClick={() => addTag(t)}>
              <Plus size={14} aria-hidden="true" />
              {t}
            </button>
          ))}
        </div>
        {draft.interestTags.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Your topics">
            {draft.interestTags.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  className="nvp-chip"
                  aria-pressed="true"
                  aria-label={`Remove ${t}`}
                  onClick={() => update({ interestTags: draft.interestTags.filter((x) => x !== t) })}
                >
                  {t}
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 flex gap-2">
          <label htmlFor="tag-input" className="sr-only">
            Add a topic
          </label>
          <input
            id="tag-input"
            className="nvp-input"
            value={tagDraft}
            placeholder="Add your own topic"
            autoComplete="off"
            maxLength={40}
            aria-invalid={tagError ? true : undefined}
            aria-describedby={tagError ? "tag-error" : undefined}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(tagDraft);
              }
            }}
          />
          <button type="button" className="nvp-btn" onClick={() => addTag(tagDraft)}>
            Add
          </button>
        </div>
        {tagError ? (
          <p id="tag-error" className="nvp-error mt-2" role="alert">
            {tagError}
          </p>
        ) : null}
      </fieldset>
      <ChoiceChips
        legend="Things you have done so far (optional)"
        options={EXPERIENCE_OPTIONS}
        value={draft.priorExperience}
        onChange={(v) => update({ priorExperience: v })}
        multiple
      />
      <SelectField
        label="Time you can give to applications (optional)"
        hint="Used to keep each season's plan realistic. It is not a rating."
        value={draft.weeklyPrepHours === null ? null : String(draft.weeklyPrepHours)}
        options={PREP_HOURS_OPTIONS}
        onChange={(v) => update({ weeklyPrepHours: v === null ? null : Number(v) })}
        placeholder="Not sure"
      />
      <div className="border-t border-[color:var(--nvp-line)] pt-2">
        <SwitchRow
          label="Solid surfaces"
          description="Swap frosted glass for solid panels on this device. You can change it later in Settings."
          checked={looks.solid}
          onChange={looks.setSolid}
        />
      </div>
    </>
  );
}

function ReviewStep({ draft, goTo }: { draft: Draft; goTo: (s: Step) => void }) {
  const rows: { label: string; value: string; step: Step }[] = [
    {
      label: "Born",
      value: draft.birthYear && draft.birthMonth ? `${MONTH_OPTIONS[draft.birthMonth - 1]?.label} ${draft.birthYear}` : "Not set",
      step: "age",
    },
    { label: "Class year", value: draft.classYear ? CLASS_YEAR_LABELS[draft.classYear] : "Not set", step: "year" },
    { label: "Graduating", value: draft.graduationTerm ? draft.graduationTerm.replace("-", " ").replace(/^\w/, (c) => c.toUpperCase()) : "Not sure yet", step: "year" },
    { label: "Field", value: draft.majorFamily ? MAJOR_FAMILY_LABELS[draft.majorFamily] : "Not set", step: "study" },
    { label: "GPA", value: GPA_OPTIONS.find((g) => g.value === draft.gpaBand)?.label ?? "Skipped", step: "study" },
    { label: "Looking for", value: draft.categories.map((c) => CATEGORY_LABELS[c]).join(", ") || "Not set", step: "interests" },
    { label: "Topics", value: draft.interestTags.join(", ") || "None", step: "interests" },
  ];
  return (
    <dl className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="nvp-inset flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <dt className="nvp-label">{r.label}</dt>
            <dd className="mt-0.5 text-[15.5px]">{r.value}</dd>
          </div>
          <button type="button" className="text-[13.5px] underline underline-offset-2" onClick={() => goTo(r.step)} aria-label={`Change ${r.label.toLowerCase()}`}>
            Change
          </button>
        </div>
      ))}
    </dl>
  );
}
