import { extractContact } from "./contact";
import { resolveNow, type ResumeNow } from "./dates";
import { findDegree, parseEducationEntry } from "./education";
import { splitEntries, type Entry } from "./entries";
import { parseExperienceEntry } from "./experience";
import { layoutLines, type LogicalLine } from "./layout";
import { hasInstitutionWord } from "./lexicon/roles";
import { itemsFromAwardLines, itemsFromCourseLines, itemsFromSkillLines, labelledItems } from "./lists";
import { parseProjectEntry } from "./projects";
import { splitSections } from "./sections";
import { mineSkills, normalizeSkills } from "./skills";
import { uniqueBy } from "./text";
import type {
  EducationEntry,
  ExperienceEntry,
  ParsedResume,
  ParseResumeInput,
  ProjectEntry,
  ResumeSection,
  ResumeWarning,
  ResumeWarningCode,
  SectionKey,
} from "./types";

/**
 * parseResumeText: reader output (or pasted text) to a JSON Resume-shaped ParsedResume, on
 * the device. Pure and synchronous; a Worker can run it as is.
 */

const WARNING_TEXT: Record<ResumeWarningCode, string> = {
  "empty-input": "We could not find any text. Try pasting your resume instead.",
  "input-truncated": "Your resume is very long, so we read the first part only.",
  "no-headings-found": "We could not find section headings, so some details may be missing. You can add them below.",
  "two-column-guess": "This looks like a two-column layout. Check that each entry landed in the right section.",
  "name-not-found": "We could not tell which line is your name. That is fine: it stays on this device either way.",
  "no-education-found": "We did not find your school or graduation year. Add them below.",
  "no-experience-found": "We did not find experience or projects. Classes, clubs and personal projects all count; add one below.",
  "no-skills-found": "We did not find a skills list. Add a few skills below.",
  "references-dropped": "We left out your references. They name other people, so they never leave this device.",
};

const ENTRY_SECTIONS: ReadonlySet<SectionKey> = new Set(["experience", "research", "activities", "volunteer"]);
const LIST_SECTIONS: ReadonlySet<SectionKey> = new Set(["skills", "languages", "coursework"]);

function emptyResume(warnings: ResumeWarning[]): ParsedResume {
  return {
    contact: { name: null, email: null, phone: null, location: null, aliases: [] },
    education: [],
    experience: [],
    projects: [],
    skills: [],
    coursework: [],
    awards: [],
    links: [],
    sections: [],
    warnings,
  };
}

function sectionSpan(key: SectionKey, heading: string | null, lines: readonly LogicalLine[], headingLine: number | null): ResumeSection {
  const first = headingLine ?? lines[0]?.index ?? 0;
  const last = lines.length > 0 ? (lines[lines.length - 1] as LogicalLine).index : first;
  return { key, heading, lineStart: first, lineEnd: last + 1, lines: lines.map((l) => l.text) };
}

/**
 * Without an education heading, a school can still sit in the header or summary: each line
 * naming a school or a degree becomes an entry with the line after it.
 */
function fallbackEducation(lines: readonly LogicalLine[], now: ResumeNow): EducationEntry[] {
  const out: EducationEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as LogicalLine;
    if (!hasInstitutionWord(line.text) && !findDegree([line.text])) continue;
    const next = lines[i + 1];
    const entry: Entry = { header: next && !hasInstitutionWord(next.text) ? [line, next] : [line], bullets: [], notes: [] };
    const parsed = parseEducationEntry(entry, now);
    if (parsed && (parsed.institution || parsed.degreeLevel)) out.push(parsed);
    if (entry.header.length === 2) i++;
  }
  return out;
}

function dedupeText(items: readonly string[]): string[] {
  return uniqueBy(
    items.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean),
    (s) => s.toLowerCase(),
  );
}

export function parseResumeText(input: ParseResumeInput): ParsedResume {
  const now = resolveNow(input?.now);
  const text = typeof input?.text === "string" ? input.text : "";
  const lines = Array.isArray(input?.lines) ? input.lines : undefined;
  const layout = layoutLines({ text, lines }, now);
  const warnings: ResumeWarning[] = [];
  const warn = (code: ResumeWarningCode): void => {
    if (!warnings.some((w) => w.code === code)) warnings.push({ code, text: WARNING_TEXT[code] });
  };
  if (layout.truncated) warn("input-truncated");
  if (layout.lines.length === 0) {
    warn("empty-input");
    return emptyResume(warnings);
  }
  if (layout.twoColumn) warn("two-column-guess");

  const sectioned = splitSections(layout.lines, layout.bodyFontSize);
  if (sectioned.noHeadings) warn("no-headings-found");
  const { contact, links } = extractContact(sectioned.profile, layout.lines, input?.hints ?? {});

  const education: EducationEntry[] = [];
  const experience: ExperienceEntry[] = [];
  const projects: ProjectEntry[] = [];
  const rawSkills: string[] = [];
  const coursework: string[] = [];
  const awards: string[] = [];
  const sections: ResumeSection[] = [];
  const looseLines: LogicalLine[] = [...sectioned.profile];

  if (sectioned.profile.length > 0) sections.push(sectionSpan("profile", null, sectioned.profile, null));
  for (const s of sectioned.sections) {
    if (s.key === "references") {
      warn("references-dropped");
      continue;
    }
    sections.push(sectionSpan(s.key, s.heading, s.lines, s.headingLine));
    const texts = s.lines.map((l) => l.text);
    if (!LIST_SECTIONS.has(s.key)) looseLines.push(...s.lines);
    if (s.key === "education") {
      for (const e of splitEntries(s.lines, { now, education: true })) {
        const parsed = parseEducationEntry(e, now);
        if (parsed) education.push(parsed);
      }
    } else if (ENTRY_SECTIONS.has(s.key)) {
      for (const e of splitEntries(s.lines, { now })) {
        const parsed = parseExperienceEntry(e, s.key, now);
        if (parsed) experience.push(parsed);
      }
    } else if (s.key === "projects") {
      for (const e of splitEntries(s.lines, { now })) {
        const parsed = parseProjectEntry(e, now);
        if (parsed) projects.push(parsed);
      }
    } else if (s.key === "skills" || s.key === "languages") {
      const items = itemsFromSkillLines(texts);
      rawSkills.push(...items.skills);
      coursework.push(...items.coursework);
    } else if (s.key === "coursework") {
      coursework.push(...itemsFromCourseLines(texts));
    } else if (s.key === "awards") {
      awards.push(...itemsFromAwardLines(texts, now));
    } else if (s.key === "certifications") {
      rawSkills.push(...mineSkills(texts.join("\n")));
    }
  }

  const labelled = labelledItems(looseLines.filter((l) => !sectioned.sections.some((s) => s.key === "education" && s.lines.includes(l))).map((l) => l.text));
  rawSkills.push(...labelled.skills);
  coursework.push(...labelled.coursework);

  if (education.length === 0) {
    const candidates = [...sectioned.profile, ...sectioned.sections.filter((s) => s.key === "summary" || s.key === "other").flatMap((s) => s.lines)];
    education.push(...fallbackEducation(candidates, now));
  }
  for (const e of education) {
    coursework.push(...e.courses);
    awards.push(...e.highlights);
  }

  const mined = [...projects.flatMap((p) => p.keywords), ...mineSkills(experience.flatMap((e) => e.highlights).join("\n"))];
  const skills = uniqueBy(normalizeSkills([...rawSkills, ...mined]), (s) => s.id)
    .map((s) => s.name)
    .slice(0, 80);

  if (!contact.name) warn("name-not-found");
  if (education.length === 0) warn("no-education-found");
  if (experience.length === 0 && projects.length === 0) warn("no-experience-found");
  if (skills.length === 0) warn("no-skills-found");

  return {
    contact,
    education,
    experience,
    projects,
    skills,
    coursework: dedupeText(coursework).slice(0, 60),
    awards: dedupeText(awards).slice(0, 40),
    links,
    sections,
    warnings,
  };
}
