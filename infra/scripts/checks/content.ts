/**
 * Content check for public surfaces (client/ and server/pages/): no prototype branding, no
 * "% ready" style readiness number about a student, no person-attributed testimonials. Readiness
 * is shown as four parts, never one composite score.
 */
import { lineOf, type Finding } from "./files";

const CHECK = "content";

const RULES: ReadonlyArray<{ re: RegExp; message: string }> = [
  { re: /\bPathful\b/gi, message: 'prototype brand "Pathful"' },
  { re: /%\s*ready\b/gi, message: 'readiness shown as a percentage ("% ready")' },
  { re: /\b(?:readiness|match)\s+score\b/gi, message: "readiness or match shown as a score" },
  { re: /\btestimonials?\b/gi, message: "testimonials (person-attributed quotes are not allowed)" },
];

export function isContentScope(file: string): boolean {
  if (/\.test\.tsx?$/.test(file)) return false;
  return /^(client\/|server\/pages\/)/.test(file) && /\.(tsx?|jsx?|html|md|css|json)$/.test(file);
}

export function checkContent(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { re, message } of RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) findings.push({ check: CHECK, file, line: lineOf(text, m.index ?? 0), message });
  }
  return findings;
}
