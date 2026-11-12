import type { ResumeNow } from "./dates";
import { coursesFromText } from "./education";
import { isMetaText } from "./layout";
import { mineSkills } from "./skills";
import { splitList, stripBullet, trimPunctuation, wordCount } from "./text";

/**
 * List sections and labelled lines: skills ("Languages: Python, Java"), coursework
 * ("Relevant Coursework: Data Structures, Linear Algebra") and awards.
 */

const LABEL = /^\s*([A-Za-z][A-Za-z &/+.'-]{0,40}?)\s*:\s*(.+)$/;
const INTEREST_LABEL = /^(?:(?:personal\s+)?interests?|hobbies|activities|other\s+interests)$/i;
export const COURSE_LABEL_ONLY = /^(?:relevant\s+|related\s+|selected\s+|key\s+)?(?:course\s?work|courses|classes)$/i;
export const SKILL_LABEL_ONLY =
  /^(?:(?:technical\s+|computer\s+|relevant\s+|additional\s+|core\s+|soft\s+|hard\s+|lab(?:oratory)?\s+|research\s+|design\s+|business\s+)?skills|(?:programming\s+|spoken\s+|computer\s+)?languages?|tools|software|technologies|frameworks?(?:\s*(?:and|&|\/)\s*libraries)?|libraries|databases?|platforms|certifications?|certificates|proficiencies|competencies|developer\s+tools|lab\s+techniques|techniques|methods|instruments|equipment)$/i;
const SKILL_PREFIX = /^(?:(?:highly\s+)?(?:proficient|familiar|experienced|skilled|fluent|knowledgeable|comfortable|competent)\s+(?:in|with)\s+|(?:working\s+|basic\s+)?knowledge\s+of\s+|experience\s+(?:in|with)\s+)/i;
const LIST_SEPARATORS = /[,;|•·∙\t]/;

export interface ListItems {
  skills: string[];
  coursework: string[];
}

/** Items from the lines of a skills or languages section. */
export function itemsFromSkillLines(lines: readonly string[]): ListItems {
  const out: ListItems = { skills: [], coursework: [] };
  for (const raw of lines) {
    const line = stripBullet(raw);
    if (!line) continue;
    const labelled = LABEL.exec(line);
    let body = line;
    if (labelled && labelled[1] && labelled[2]) {
      const label = labelled[1].trim();
      if (INTEREST_LABEL.test(label)) continue;
      if (COURSE_LABEL_ONLY.test(label)) {
        out.coursework.push(...coursesFromText(labelled[2]));
        continue;
      }
      body = labelled[2];
    }
    if (wordCount(body) > 14 && !LIST_SEPARATORS.test(body)) {
      out.skills.push(...mineSkills(body));
      continue;
    }
    for (const item of splitList(body, LIST_SEPARATORS)) out.skills.push(item.replace(SKILL_PREFIX, ""));
  }
  return out;
}

/** "Skills: …" and "Relevant Coursework: …" lines found anywhere in the resume. */
export function labelledItems(lines: readonly string[]): ListItems {
  const out: ListItems = { skills: [], coursework: [] };
  for (const raw of lines) {
    const labelled = LABEL.exec(stripBullet(raw));
    if (!labelled || !labelled[1] || !labelled[2]) continue;
    const label = labelled[1].trim();
    if (COURSE_LABEL_ONLY.test(label)) out.coursework.push(...coursesFromText(labelled[2]));
    else if (SKILL_LABEL_ONLY.test(label)) {
      for (const item of splitList(labelled[2], LIST_SEPARATORS)) out.skills.push(item.replace(SKILL_PREFIX, ""));
    }
  }
  return out;
}

/** Courses from the lines of a coursework section. */
export function itemsFromCourseLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = stripBullet(raw);
    const labelled = LABEL.exec(line);
    out.push(...coursesFromText(labelled && labelled[2] ? labelled[2] : line));
  }
  return out;
}

const AWARD_LABEL = /^\s*(?:honou?rs?|awards?|honou?rs\s*(?:and|&)\s*awards?|awards\s*(?:and|&)\s*honou?rs|scholarships?|achievements?)\s*:\s*(.+)$/i;

/** Awards, one per line or listed after an "Honors:" label. */
export function itemsFromAwardLines(lines: readonly string[], now: ResumeNow): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = stripBullet(raw);
    if (!line) continue;
    const labelled = AWARD_LABEL.exec(line);
    const items = labelled && labelled[1] ? splitList(labelled[1], /[,;|•·\t]/) : splitList(line, /[;|•·\t]/);
    for (const item of items) {
      const clean = trimPunctuation(item.replace(/\s+/g, " "));
      if (clean && /\p{L}/u.test(clean) && clean.length <= 160 && !isMetaText(clean, now)) out.push(clean);
    }
  }
  return out;
}
