import { findDates, type DateMatch, type ResumeNow } from "./dates";
import type { Entry } from "./entries";
import type { LogicalLine } from "./layout";
import { locationRegex } from "./lexicon/places";
import {
  COMPETITION_RE,
  hasOrgWord,
  hasRoleWord,
  INSIGHT_RE,
  INTERN_RE,
  LEADERSHIP_RE,
  MEMBER_RE,
  PART_TIME_RE,
  RESEARCH_ROLE_RE,
  TEACHING_RE,
  VOLUNTEER_RE,
} from "./lexicon/roles";
import { isAllCaps, splitCells, trimPunctuation, wordCount } from "./text";
import type { ExperienceEntry, ResumeEntryKind, SectionKey } from "./types";

/**
 * Experience, research, activity and volunteer entries. Each header cell is scored as a role
 * and as an organization with additive features (role word +4, bold +3, organization word +3,
 * and so on) and the best cell wins, the documented OpenResume feature-scoring method.
 */

export interface HeaderCell {
  text: string;
  bold: boolean;
  line: number;
}

export interface HeaderParts {
  cells: HeaderCell[];
  dates: DateMatch | null;
  location: string | null;
}

/** Words a date leaves behind once it is cut out ("Expected", "Class of"). */
const DATE_LEFTOVER = /^(?:expected|anticipated|projected|exp\.?|est\.?|class\s+of|graduation(?:\s+date)?|graduating|grad\.?|since|from|to|dates?|present|current|\(|\))$/i;

function blankSpans(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let out = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)}\t${out.slice(b)}`;
  return out;
}

/** Splits "Intern at Acme", "Treasurer, Chess Club" and "Chess Club (President)" into parts. */
export function splitHeaderCell(raw: string): string[] {
  const text = trimPunctuation(raw);
  if (!text) return [];
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(text);
  if (at && at[1] && at[2] && hasRoleWord(at[1])) return [at[1].trim(), at[2].trim()];
  const paren = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(text);
  if (paren && paren[1] && paren[2] && hasRoleWord(paren[2])) return [paren[1].trim(), paren[2].trim()];
  if (text.includes(",")) {
    const parts: string[] = [];
    for (const p of text.split(/\s*,\s*/)) {
      if (/^(?:Inc\.?|LLC|L\.L\.C\.|Ltd\.?|Co\.|Corp\.?|P\.?C\.?|LLP)$/i.test(p) && parts.length > 0) parts[parts.length - 1] += `, ${p}`;
      else if (p) parts.push(p);
    }
    if (parts.length >= 2 && parts.length <= 4 && parts.some((p) => hasRoleWord(p))) return parts;
  }
  return [text];
}

/** Widens a date span to swallow the brackets around it: "(Summer 2026)" goes as a whole. */
function withBrackets(text: string, start: number, end: number): readonly [number, number] {
  let a = start;
  let b = end;
  while (a > 0 && /\s/.test(text[a - 1] ?? "")) a--;
  while (b < text.length && /\s/.test(text[b] ?? "")) b++;
  if ((text[a - 1] === "(" && text[b] === ")") || (text[a - 1] === "[" && text[b] === "]")) return [a - 1, b + 1];
  return [start, end];
}

/**
 * Drops parentheses that lost their partner when a date or place was cut out
 * ("Lone Star Credit Union (" -> "Lone Star Credit Union"); balanced pairs stay.
 */
export function dropUnmatchedParens(cell: string): string {
  const chars = [...cell];
  const open: number[] = [];
  const drop = new Set<number>();
  chars.forEach((ch, i) => {
    if (ch === "(") open.push(i);
    else if (ch === ")") {
      if (open.length > 0) open.pop();
      else drop.add(i);
    }
  });
  for (const i of open) drop.add(i);
  return chars
    .filter((_, i) => !drop.has(i))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts dates and locations out of header lines and splits the rest into cells. */
export function headerParts(lines: readonly LogicalLine[], now: ResumeNow): HeaderParts {
  let dates: DateMatch | null = null;
  let location: string | null = null;
  const cells: HeaderCell[] = [];
  lines.forEach((line, i) => {
    const found = findDates(line.text, now);
    if (!dates && found[0]) dates = found[0];
    let text = blankSpans(line.text, found.map((d) => withBrackets(line.text, d.index, d.index + d.length)));
    const locSpans: Array<readonly [number, number]> = [];
    for (const m of text.matchAll(locationRegex())) {
      // "Peer Tutor, CA" is a title before a state code, not a place.
      if (hasRoleWord(m[0].split(",")[0] ?? "")) continue;
      if (!location) location = m[0].trim();
      locSpans.push(withBrackets(text, m.index ?? 0, (m.index ?? 0) + m[0].length));
    }
    text = blankSpans(text, locSpans);
    for (const raw of splitCells(text)) {
      for (const part of splitHeaderCell(raw)) {
        const clean = trimPunctuation(dropUnmatchedParens(part));
        if (clean && /\p{L}/u.test(clean) && !DATE_LEFTOVER.test(clean)) cells.push({ text: clean, bold: line.bold, line: i });
      }
    }
  });
  return { cells, dates, location };
}

/** The last word of a cell, which is the head noun in English titles ("Pharmacy Technician"). */
function lastWord(text: string): string {
  const words = text.trim().split(/\s+/);
  return words[words.length - 1] ?? "";
}

/**
 * Role score. A role word counts most when it is the head noun: "Library Assistant" is a role
 * even though "Library" names places, and "Cupertino Public Library" is an organization.
 */
export function roleScore(c: HeaderCell): number {
  let s = 0;
  const head = lastWord(c.text);
  if (hasRoleWord(c.text)) s += 4;
  if (hasRoleWord(head)) s += 2;
  if (/^(?:Senior|Junior|Lead|Head|Undergraduate|Student|Summer|Peer|Assistant|Associate|Chief|Co-)/.test(c.text)) s += 1;
  if (hasOrgWord(c.text)) s -= hasOrgWord(head) ? 4 : 1;
  if (wordCount(c.text) > 7) s -= 2;
  return s;
}

export function orgScore(c: HeaderCell, index: number): number {
  let s = 0;
  const head = lastWord(c.text);
  if (c.bold) s += 3;
  if (hasOrgWord(c.text)) s += hasOrgWord(head) ? 4 : 2;
  if (isAllCaps(c.text)) s += 1;
  if (hasRoleWord(c.text) && !hasOrgWord(head)) s -= hasRoleWord(head) ? 5 : 2;
  return s - index * 0.1;
}

/** Picks the role and organization cells. Without a role word, the organization comes first. */
export function assignRoleAndOrg(cells: readonly HeaderCell[]): { position: string | null; organization: string | null } {
  if (cells.length === 0) return { position: null, organization: null };
  let roleIdx = -1;
  let best = 2;
  cells.forEach((c, i) => {
    const s = roleScore(c);
    if (s > best) {
      best = s;
      roleIdx = i;
    }
  });
  const rest = cells.map((c, i) => ({ c, i })).filter(({ i }) => i !== roleIdx);
  if (roleIdx >= 0) {
    if (rest.length === 0) return { position: (cells[roleIdx] as HeaderCell).text, organization: null };
    const org = rest.reduce((a, b) => (orgScore(b.c, b.i) > orgScore(a.c, a.i) ? b : a));
    return { position: (cells[roleIdx] as HeaderCell).text, organization: org.c.text };
  }
  const first = cells[0] as HeaderCell;
  const second = cells[1];
  if (!second) return { position: null, organization: first.text };
  if (second.bold && !first.bold) return { position: first.text, organization: second.text };
  return { position: second.text, organization: first.text };
}

const CLUB_ORG = /\b(?:Club|Society|Association|Team|Chapter|Organization|Council|Ensemble|Orchestra|Band|Choir|Chorus|Troupe|Squad|League|Union|Alliance|Collective|Committee)\b/;

/**
 * Entry kind from title, organization and section words. Explicit role words decide first;
 * the "a lab means research" guess only applies to generic titles, so a tutor in a math lab
 * stays a tutor. Without a title, the first bullet stands in ("Captain of the soccer team").
 */
export function inferKind(position: string | null, organization: string | null, section: SectionKey, bullets: readonly string[] = []): ResumeEntryKind {
  const p = position ?? (organization ? "" : (bullets[0] ?? ""));
  const o = organization ?? "";
  const both = `${p} ${o}`;
  if (INSIGHT_RE.test(both)) return "insight";
  if (section === "research") return "research";
  if (RESEARCH_ROLE_RE.test(p)) return "research";
  if (INTERN_RE.test(p)) return "internship";
  if (section === "volunteer" || VOLUNTEER_RE.test(p)) return "volunteer";
  if (TEACHING_RE.test(p)) return "teaching";
  if (/\b(?:Lab|Laboratory)\b/.test(o) && !PART_TIME_RE.test(p) && !LEADERSHIP_RE.test(p)) return "research";
  if (COMPETITION_RE.test(both)) return "competition";
  if (section === "activities") return LEADERSHIP_RE.test(p) ? "leadership" : "club";
  // "Suspension Team Member, Formula Racing Team" is a club; "Team Member, Target" is a job.
  if (MEMBER_RE.test(p) && CLUB_ORG.test(o)) return "club";
  if (PART_TIME_RE.test(p)) return "part_time";
  if (LEADERSHIP_RE.test(p) && CLUB_ORG.test(o)) return "leadership";
  return "work";
}

export function parseExperienceEntry(entry: Entry, section: SectionKey, now: ResumeNow): ExperienceEntry | null {
  const parts = headerParts(entry.header, now);
  const { position, organization } = assignRoleAndOrg(parts.cells);
  const highlights = [...entry.bullets, ...entry.notes].map((h) => h.trim()).filter(Boolean);
  if (!position && !organization && highlights.length === 0) return null;
  const d = parts.dates as DateMatch | null;
  return {
    kind: inferKind(position, organization, section, highlights),
    position,
    organization,
    location: parts.location,
    startDate: d?.start ?? null,
    endDate: d?.end ?? null,
    current: d?.open ?? false,
    highlights,
    section,
  };
}
