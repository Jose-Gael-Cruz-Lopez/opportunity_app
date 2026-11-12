import { findDates, type ResumeNow } from "./dates";
import { findDegree } from "./education";
import type { LogicalLine } from "./layout";
import { hasInstitutionWord, hasOrgWord, hasRoleWord } from "./lexicon/roles";
import { isAllCaps, isBulletLine, median, stripBullet, wordCount } from "./text";

/**
 * Splits the lines of an entry-based section (education, experience, projects, activities)
 * into entries. A new entry starts at a vertical gap wider than 1.4 times the typical line
 * gap (the documented OpenResume rule), at a blank line in pasted text, at a header line that
 * follows bullets, at a second dated header, or at a second complete "role, organization"
 * header. Bullets without a glyph are recognized by indentation or a leading action verb.
 */

export interface Entry {
  header: LogicalLine[];
  bullets: string[];
  /** Long non-bullet sentences after the header (a project description). */
  notes: string[];
}

/** Verbs that open resume bullets; a line starting with one is a bullet even without a glyph. */
const ACTION_VERB = new RegExp(
  `^(?:${[
    "Built", "Led", "Developed", "Designed", "Created", "Managed", "Organized", "Implemented", "Analyzed", "Analysed",
    "Conducted", "Collaborated", "Assisted", "Coordinated", "Taught", "Tutored", "Mentored", "Wrote", "Researched",
    "Presented", "Improved", "Increased", "Reduced", "Launched", "Founded", "Planned", "Trained", "Served", "Prepared",
    "Processed", "Maintained", "Supported", "Handled", "Engineered", "Programmed", "Automated", "Optimized", "Optimised",
    "Tested", "Deployed", "Published", "Raised", "Recruited", "Facilitated", "Hosted", "Performed", "Operated",
    "Monitored", "Evaluated", "Investigated", "Synthesized", "Measured", "Modeled", "Modelled", "Simulated", "Prototyped",
    "Delivered", "Achieved", "Won", "Earned", "Volunteered", "Helped", "Worked", "Contributed", "Partnered",
    "Spearheaded", "Directed", "Oversaw", "Streamlined", "Documented", "Drafted", "Edited", "Translated", "Answered",
    "Greeted", "Cleaned", "Cooked", "Restocked", "Balanced", "Sold", "Assembled", "Repaired", "Installed", "Configured",
    "Debugged", "Refactored", "Integrated", "Scaled", "Gathered", "Collected", "Interviewed", "Surveyed", "Coded",
    "Visualized", "Scraped", "Fine-tuned", "Guided", "Advised", "Ran", "Used", "Applied", "Reviewed", "Compiled",
    "Authored", "Co-authored", "Produced", "Filmed", "Photographed", "Promoted", "Marketed", "Negotiated", "Secured",
    "Generated", "Expanded", "Established", "Initiated", "Introduced", "Revamped", "Redesigned", "Shipped", "Wrangled",
    "Explored", "Learned", "Studied", "Practiced", "Competed", "Placed", "Represented", "Utilized", "Leveraged",
    "Executed", "Identified", "Resolved", "Calculated", "Cultivated", "Strengthened", "Boosted", "Grew", "Taught",
  ].join("|")})\\b`,
);

export interface SplitOptions {
  now: ResumeNow;
  /** Education sections also split at a second school name. */
  education?: boolean;
}

interface Building extends Entry {
  headerX: number | null;
  headerIndent: number;
  hasDate: boolean;
}

const hasDate = (text: string, now: ResumeNow): boolean => findDates(text, now).length > 0;

/** "Scholarships: ...", "Relevant Coursework: ...": a labelled detail line, never a new entry. */
const LABELLED = /^[^:]{1,32}:\s*\S/;

/**
 * True when a line names a school. A degree statement does not count ("High School Diploma"
 * holds the word School), nor does a labelled line ("Scholarships: ... College Match ...").
 */
export function namesSchool(text: string): boolean {
  if (LABELLED.test(text)) return false;
  const degree = findDegree([text]);
  return hasInstitutionWord(degree ? text.replace(degree.text, " ") : text);
}

/**
 * A sentence that opens with a past-tense verb ("Shelved and checked out 500 books"): at least
 * five words, three of them lowercase, so a title such as "Licensed Practical Nurse at Mercy"
 * is not taken for one.
 */
function pastTenseSentence(text: string): boolean {
  if (!/^\p{Lu}\p{Ll}{2,}ed\b/u.test(text) || wordCount(text) < 5) return false;
  return (text.match(/(?:^|\s)\p{Ll}/gu) ?? []).length >= 3;
}

function looksLikeHeader(line: LogicalLine, now: ResumeNow): boolean {
  const t = line.text;
  return hasDate(t, now) || line.bold || isAllCaps(t) || hasRoleWord(t) || hasOrgWord(t) || hasInstitutionWord(t) || /[\t|]/.test(t);
}

/** The header names both a role and an organization ("President, Chess Club"). */
function headerComplete(entry: Building): boolean {
  const text = entry.header.map((l) => l.text).join(" | ");
  return hasRoleWord(text) && (hasOrgWord(text) || /[\t|,]/.test(text) || entry.header.length >= 2);
}

function bulletLike(line: LogicalLine, entry: Building | null): boolean {
  const text = line.text.trim();
  if (isBulletLine(text)) return true;
  if (!entry || entry.header.length === 0) return false;
  if (ACTION_VERB.test(text) && wordCount(text) >= 4) return true;
  if (pastTenseSentence(text)) return true;
  if (line.x !== null && entry.headerX !== null && line.fontSize !== null && line.x > entry.headerX + 0.8 * line.fontSize && !line.bold) return true;
  return line.x === null && line.indent > entry.headerIndent + 1;
}

function continues(line: LogicalLine, previous: string, now: ResumeNow): boolean {
  const text = line.text.trim();
  if (/^[\p{Ll}(&,;%]/u.test(text)) return true;
  if (looksLikeHeader(line, now)) return false;
  return !/[.!?;:]$/.test(previous.trim()) && wordCount(text) <= 14;
}

export function splitEntries(lines: readonly LogicalLine[], options: SplitOptions): Entry[] {
  const { now } = options;
  const gaps = lines.map((l) => l.gapBefore).filter((g): g is number => g !== null && g > 0);
  const typicalGap = median(gaps);
  const entries: Building[] = [];
  let cur: Building | null = null;

  const start = (line: LogicalLine): Building => {
    const entry: Building = { header: [line], bullets: [], notes: [], headerX: line.x, headerIndent: line.indent, hasDate: hasDate(line.text, now) };
    entries.push(entry);
    return entry;
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (!cur) {
      if (bulletLike(line, null)) {
        cur = start({ ...line, text: "" });
        cur.header = [];
        cur.bullets.push(stripBullet(text));
      } else cur = start(line);
      continue;
    }
    const hasContent = cur.header.length + cur.bullets.length + cur.notes.length > 0;
    const bigGap = typicalGap !== null && line.gapBefore !== null && line.gapBefore > 1.4 * typicalGap;
    const bullet = bulletLike(line, cur);

    if (hasContent && (bigGap || line.blankBefore) && !bullet) {
      cur = start(line);
      continue;
    }
    if (bullet) {
      cur.bullets.push(stripBullet(text));
      continue;
    }
    const lastBullet = cur.bullets[cur.bullets.length - 1];
    if (lastBullet !== undefined) {
      if (continues(line, lastBullet, now)) {
        cur.bullets[cur.bullets.length - 1] = `${lastBullet} ${text}`;
        continue;
      }
      cur = start(line);
      continue;
    }
    const dated = hasDate(text, now);
    if (options.education && namesSchool(text) && cur.header.some((h) => namesSchool(h.text))) {
      cur = start(line);
      continue;
    }
    if (dated && cur.hasDate && !options.education) {
      cur = start(line);
      continue;
    }
    if (!dated && headerComplete(cur) && (hasRoleWord(text) || hasOrgWord(text)) && !options.education && cur.header.length >= 1 && cur.hasDate === false && /[\t|,()]/.test(text)) {
      cur = start(line);
      continue;
    }
    // Once a header has a role, an organization and a date, a plain sentence after it is a
    // bullet even without a glyph or a known verb ("Tutor 20 students a week").
    if (!options.education && cur.hasDate && headerComplete(cur) && !looksLikeHeader(line, now) && wordCount(text) >= 4 && /\p{Ll}/u.test(text)) {
      cur.bullets.push(stripBullet(text));
      continue;
    }
    if (cur.header.length >= 3 && wordCount(text) >= 8 && !looksLikeHeader(line, now)) {
      cur.notes.push(text);
      continue;
    }
    if (cur.header.length >= 1 && wordCount(text) >= 10 && /[.!?]$/.test(text)) {
      cur.notes.push(text);
      continue;
    }
    cur.header.push(line);
    cur.hasDate ||= dated;
  }
  return entries
    .filter((e) => e.header.length + e.bullets.length + e.notes.length > 0)
    .map(({ header, bullets, notes }) => ({ header, bullets, notes }));
}
