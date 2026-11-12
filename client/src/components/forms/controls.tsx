import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Form controls for the Novus look. Native elements first (button, select, input) so keyboard,
 * screen readers and mobile pickers work without extra code; ARIA only where a native element
 * has no equivalent (a pill that acts as a checkbox, a switch).
 */

export interface Option<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly hint?: string;
}

/** A pill that toggles, announced as a checkbox (roadmap items, plan checks). */
export function CheckPill({
  checked,
  onChange,
  children,
  disabled,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      className="nvp-check"
      onClick={() => onChange(!checked)}
    >
      <span className="nvp-ring" aria-hidden="true">
        <Check strokeWidth={2.6} />
      </span>
      <span className="nvp-check-label min-w-0 flex-1">{children}</span>
    </button>
  );
}

/**
 * A group of chips. Single mode behaves like a radio group of toggle buttons; multi mode like
 * checkboxes. Each chip is a real button with aria-pressed, so Tab and Space/Enter work.
 */
export function ChoiceChips<V extends string>({
  legend,
  options,
  value,
  onChange,
  multiple = false,
  max,
  hideLegend = false,
}: {
  legend: string;
  options: readonly Option<V>[];
  value: readonly V[];
  onChange: (next: V[]) => void;
  multiple?: boolean;
  max?: number;
  hideLegend?: boolean;
}) {
  const atMax = multiple && max !== undefined && value.length >= max;
  const toggle = (v: V) => {
    if (!multiple) return onChange([v]);
    if (value.includes(v)) return onChange(value.filter((x) => x !== v));
    if (atMax) return;
    onChange([...value, v]);
  };
  return (
    <fieldset className="min-w-0">
      <legend className={cn("nvp-label mb-3", hideLegend && "sr-only")}>{legend}</legend>
      <div className="flex flex-wrap gap-2.5">
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className="nvp-chip"
              aria-pressed={on}
              disabled={!on && atMax}
              title={o.hint}
              onClick={() => toggle(o.value)}
            >
              {multiple ? (
                <span aria-hidden="true" className="nvp-chip-mark">
                  {on ? <Check size={16} strokeWidth={2.4} /> : null}
                </span>
              ) : null}
              {o.label}
            </button>
          );
        })}
      </div>
      {multiple && max !== undefined ? (
        <p className="nvp-meta mt-2" aria-live="polite">
          {value.length} of up to {max} chosen
        </p>
      ) : null}
    </fieldset>
  );
}

export function SelectField<V extends string>({
  label,
  hint,
  error,
  value,
  options,
  onChange,
  placeholder = "Choose one",
  required,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  value: V | null;
  options: readonly Option<V>[];
  onChange: (next: V | null) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[15px] font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="nvp-meta">
          {hint}
        </p>
      ) : null}
      <select
        id={id}
        className="nvp-select"
        value={value ?? ""}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as V))}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errId} className="nvp-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  autoComplete = "off",
  inputMode,
  type = "text",
  maxLength,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "email";
  type?: "text" | "email";
  maxLength?: number;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[15px] font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="nvp-meta">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        className="nvp-input"
        type={type}
        maxLength={maxLength}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p id={errId} className="nvp-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled on/off switch with a description line. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p id={`${id}-l`} className="text-[15.5px] font-semibold">
          {label}
        </p>
        {description ? (
          <p id={`${id}-d`} className="mt-1 text-[14px] text-[color:var(--nvp-ink-3)]">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        className="nvp-switch mt-1"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

/** Step progress: a bar plus "Step 2 of 5", announced politely when it changes. */
export function StepProgress({ step, total, label }: { step: number; total: number; label: string }) {
  const pct = Math.round((Math.min(step, total) / total) * 100);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="nvp-label" aria-live="polite">
          Step {step} of {total} · {label}
        </span>
      </div>
      <div className="nvp-progress" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step} aria-valuetext={`Step ${step} of ${total}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
