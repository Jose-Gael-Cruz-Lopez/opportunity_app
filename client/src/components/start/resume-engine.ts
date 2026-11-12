import * as Resume from "@shared/resume";
import { normalizeSignals, type SignalsView } from "./resume-view";

/**
 * The seam between the resume step and @shared/resume: on-device parsing, redaction and
 * signal extraction. Everything here runs in the browser and sends nothing anywhere. The UI
 * reads outputs through the tolerant readers in resume-view.ts.
 */

export type ParsedResume = Resume.ParsedResume;
export type ResumeLine = Resume.ResumeLine;

/** Device-only hints (file name, PDF author, link targets) that seed name redaction; never sent anywhere. */
export type ParseHints = Resume.ResumeHints;

export function parseResume(text: string, lines: ResumeLine[] | undefined, now: Date, hints?: ParseHints): ParsedResume {
  return Resume.parseResumeText({ text, ...(lines && lines.length ? { lines } : {}), now, ...(hints ? { hints } : {}) });
}

export interface OutgoingPreview {
  text: string;
  removed: readonly unknown[];
}

/** Exactly the text the AI would read, after the section allowlist and redaction. */
export function outgoingText(parsed: ParsedResume): OutgoingPreview {
  const r = Resume.redactForAi(parsed);
  return { text: r.text, removed: r.removed };
}

export function signalsOf(parsed: ParsedResume): SignalsView {
  return normalizeSignals(Resume.toProfileSignals(parsed));
}

/** Skill chips in their canonical spelling (js -> JavaScript). */
export function canonicalSkills(raw: string[]): string[] {
  const out = Resume.normalizeSkills(raw) as readonly unknown[];
  return out
    .map((s: unknown) => {
      if (typeof s === "string") return s;
      const r = (s ?? {}) as Record<string, unknown>;
      return String(r.name ?? r.label ?? r.canonical ?? r.raw ?? "");
    })
    .filter(Boolean);
}
