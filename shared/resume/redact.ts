import { matchMajor } from "./majors";
import { parseResumeText } from "./parse";
import { detectPii, PII_PLACEHOLDERS, piiReason, redactPii } from "./pii";
import { lexiconKey, headingText } from "./sections";
import { detectSensitive, SENSITIVE_REASON } from "./sensitive";
import { isBulletLine, normalizeText, squash } from "./text";
import type {
  DegreeLevel,
  EducationEntry,
  ExperienceEntry,
  ParsedResume,
  PiiKind,
  ProjectEntry,
  RedactionItem,
  RedactionResult,
  RedactOptions,
  ResumeEntryKind,
  SectionKey,
} from "./types";

/**
 * redactForAi: the exact text an AI model may read, and what was left out, for the preview.
 *
 * From a ParsedResume the text is built by section allowlist, not by redacting the whole
 * resume: field of study, degree level and graduation year; role titles and bullets of
 * experience, research, activity and volunteer entries; project names, bullets and tools; the
 * skills list. Names, contact details, links, school names, organization names, awards, GPA,
 * coursework, summaries and references stay on the device, because institutions, clubs and
 * scholarships are strong proxies for race, religion, gender and income.
 *
 * Then, on what is left, two removals:
 * - Any statement that may reveal a SensitiveAnswers category removes its whole line, bullet
 *   or entry ("Treasurer, Muslim Students Association" goes as a unit, so the role cannot leak
 *   the category) and leaves one neutral "[removed]". The category never appears in the text
 *   or in RedactionItem.
 * - Contact details, identifiers and names become typed placeholders ("[email]", "[name]").
 *
 * A final gate re-runs every detector over the finished text, so the guarantee holds even if a
 * placeholder or a cut created a new match. Pure and synchronous; runs on the device.
 */

/** The server accepts about this many characters of redacted text. */
export const AI_TEXT_MAX_CHARS = 12_000;
/** The one token a sensitive removal leaves. It names no category. */
export const REMOVED_PLACEHOLDER = "[removed]";

const WITHHELD_REASON = {
  institution: "School names stay on this device. They can hint at your background, so the AI never sees them.",
  organization: "Employer, lab and club names stay on this device. The AI reads your roles and what you did.",
  awards: "Award and scholarship names stay on this device. They can hint at your background.",
  gpa: "Your GPA stays on this device.",
  coursework: "Your course list stays on this device; Novus already matched it to fields without AI.",
  section: "This section stays on this device. The AI only reads skills, roles, projects and what you studied.",
  references: "References and publications name other people, so they never leave this device.",
} as const;

const LIMIT_REASON = "The text was cut to fit the size limit. The rest stays on this device.";

// -------------------------------------------------------------------------------------------
// Building blocks
// -------------------------------------------------------------------------------------------

/** One unit of outgoing text. A sensitive hit anywhere in `guard` or `lines` removes the unit. */
interface Unit {
  /** Lines as they would be sent (before PII redaction). */
  lines: string[];
  /** Device-only text checked for sensitive statements but never sent (an organization name). */
  guard: string;
  /**
   * "all": one hit removes every line (an entry: its role, organization and bullets);
   * "each": a hit removes only the line it is on (a list of separate statements).
   */
  scope: "all" | "each";
  /** How the preview names the unit when it is removed; defaults to its first line. */
  label?: string;
}

interface Section {
  heading: string;
  units: Unit[];
}

interface Collected {
  sections: Section[];
  removed: RedactionItem[];
}

const KIND_LABEL: Record<ResumeEntryKind, string> = {
  internship: "internship",
  research: "research",
  work: "job",
  part_time: "part-time job",
  leadership: "leadership",
  club: "club or team",
  volunteer: "volunteering",
  teaching: "teaching or tutoring",
  insight: "insight program",
  competition: "competition",
};

const DEGREE_LABEL: Record<DegreeLevel, string> = {
  high_school: "High school diploma",
  certificate: "Certificate",
  associate: "Associate degree",
  bachelor: "Bachelor's degree",
  master: "Master's degree",
  doctorate: "Doctorate",
};

const SECTION_HEADING: Partial<Record<SectionKey, string>> = {
  experience: "EXPERIENCE",
  research: "RESEARCH",
  activities: "ACTIVITIES",
  volunteer: "VOLUNTEERING",
};

/** Sections whose text never leaves, with the reason the preview shows. */
const WITHHELD_SECTIONS: Partial<Record<SectionKey, string>> = {
  summary: WITHHELD_REASON.section,
  certifications: WITHHELD_REASON.section,
  publications: "Publications list co-authors and venues, so they stay on this device.",
  interests: WITHHELD_REASON.section,
  languages: WITHHELD_REASON.section,
  other: WITHHELD_REASON.section,
  references: WITHHELD_REASON.references,
};

const clean = (s: string | null | undefined): string => squash(normalizeText(s ?? ""));

function withheld(original: string, reason: string): RedactionItem | null {
  const text = clean(original);
  return text ? { kind: "withheld", reason, original: text.length > 400 ? `${text.slice(0, 399)}…` : text, placeholder: "" } : null;
}

function yearOf(iso: string | null): number | null {
  const m = iso ? /^(\d{4})/.exec(iso) : null;
  return m ? Number(m[1]) : null;
}

/** "Computer Science" for a known major (identity studies map to neutral names), else as written. */
function fieldName(area: string | null): string {
  const text = clean(area);
  if (!text) return "";
  return matchMajor(text)?.name ?? text;
}

function educationUnits(education: readonly EducationEntry[], removed: RedactionItem[]): Unit[] {
  const units: Unit[] = [];
  const seen = new Set<string>();
  const push = (line: string): void => {
    const key = line.toLowerCase();
    if (!line || seen.has(key)) return;
    seen.add(key);
    units.push({ lines: [line], guard: "", scope: "each" });
  };
  for (const e of education) {
    const area = fieldName(e.area);
    if (area) push(`Field of study: ${area}`);
    const minor = fieldName(e.minor);
    if (minor) push(`Minor: ${minor}`);
    const year = yearOf(e.endDate);
    if (e.degreeLevel || year) {
      const level = e.degreeLevel ? DEGREE_LABEL[e.degreeLevel] : "Degree";
      push(year ? `${level}, ${e.endDateExpected ? "expected " : ""}${year}` : level);
    }
    const institution = withheld(e.institution ?? "", WITHHELD_REASON.institution);
    if (institution) removed.push(institution);
    if (e.score) {
      const gpa = withheld(`GPA ${e.score}`, WITHHELD_REASON.gpa);
      if (gpa) removed.push(gpa);
    }
  }
  return units;
}

function experienceUnit(e: ExperienceEntry): Unit | null {
  const title = clean(e.position);
  const header = title ? `${title} (${KIND_LABEL[e.kind]})` : `Role (${KIND_LABEL[e.kind]})`;
  const bullets = e.highlights.map(clean).filter(Boolean).map((b) => `- ${b}`);
  if (!title && bullets.length === 0) return null;
  // The organization is checked but never sent: "Treasurer" alone is harmless, "Treasurer,
  // Black Student Union" is not, and the bullets of such an entry describe the organization.
  const label = [title, clean(e.organization)].filter(Boolean).join(", ") || header;
  return { lines: [header, ...bullets], guard: [e.organization, e.location].map(clean).filter(Boolean).join(" | "), scope: "all", label };
}

function projectUnit(p: ProjectEntry): Unit | null {
  const name = clean(p.name);
  const lines: string[] = [];
  if (name) lines.push(name);
  const description = clean(p.description);
  if (description) lines.push(`- ${description}`);
  for (const h of p.highlights) {
    const t = clean(h);
    if (t) lines.push(`- ${t}`);
  }
  if (p.keywords.length > 0) lines.push(`Tools: ${p.keywords.map(clean).filter(Boolean).join(", ")}`);
  return lines.length > 0 ? { lines, guard: "", scope: "all" } : null;
}

/** Skills one per unit, so a sensitive skill ("Bible study") removes only itself. */
function skillUnits(skills: readonly string[]): Unit[] {
  return skills.map((s) => clean(s)).filter(Boolean).map((s) => ({ lines: [s], guard: "", scope: "each" as const }));
}

function collectFromParsed(parsed: ParsedResume): Collected {
  const removed: RedactionItem[] = [];
  const sections: Section[] = [];

  // Contact details were never put in the text; listing them tells the student they stay here.
  const contact = parsed.contact;
  const contactItems: Array<[PiiKind, string | null]> = [
    ["name", contact?.name ?? null],
    ["email", contact?.email ?? null],
    ["phone", contact?.phone ?? null],
    ["address", contact?.location ?? null],
    ...(parsed.links ?? []).map((l): [PiiKind, string] => ["link", l.url]),
  ];
  for (const [kind, value] of contactItems) {
    const text = clean(value);
    if (text) removed.push({ kind, reason: piiReason(kind), original: text, placeholder: "" });
  }

  const education = educationUnits(parsed.education ?? [], removed);
  if (education.length > 0) sections.push({ heading: "EDUCATION", units: education });

  const byHeading = new Map<string, Unit[]>();
  const organizations: string[] = [];
  for (const e of parsed.experience ?? []) {
    const unit = experienceUnit(e);
    if (e.organization) organizations.push(clean(e.organization));
    if (!unit) continue;
    const heading = SECTION_HEADING[e.section] ?? "EXPERIENCE";
    const list = byHeading.get(heading) ?? [];
    list.push(unit);
    byHeading.set(heading, list);
  }
  for (const heading of ["EXPERIENCE", "RESEARCH", "ACTIVITIES", "VOLUNTEERING"]) {
    const units = byHeading.get(heading);
    if (units && units.length > 0) sections.push({ heading, units });
  }
  const orgItem = withheld([...new Set(organizations.filter(Boolean))].join("; "), WITHHELD_REASON.organization);
  if (orgItem) removed.push(orgItem);

  const projects = (parsed.projects ?? []).map(projectUnit).filter((u): u is Unit => u !== null);
  if (projects.length > 0) sections.push({ heading: "PROJECTS", units: projects });

  const skills = skillUnits(parsed.skills ?? []);
  if (skills.length > 0) sections.push({ heading: "SKILLS", units: skills });

  const awards = withheld((parsed.awards ?? []).join("; "), WITHHELD_REASON.awards);
  if (awards) removed.push(awards);
  const coursework = withheld((parsed.coursework ?? []).join("; "), WITHHELD_REASON.coursework);
  if (coursework) removed.push(coursework);
  for (const s of parsed.sections ?? []) {
    const reason = WITHHELD_SECTIONS[s.key];
    if (!reason) continue;
    const item = withheld([s.heading, ...(s.lines ?? [])].filter(Boolean).join(" · "), reason);
    if (item) removed.push(item);
  }
  return { sections, removed };
}

/**
 * Pasted or edited text: no allowlist is possible, so every line is kept unless it is a
 * sensitive statement or belongs to a References section; contact details become placeholders.
 */
function collectFromText(text: string): Collected {
  const removed: RedactionItem[] = [];
  const units: Unit[] = [];
  let inReferences = false;
  const references: string[] = [];
  for (const raw of normalizeText(text).split("\n")) {
    // Wide gaps in pasted text separate cells; keep the boundary visible but compact.
    const line = raw.replace(/\s+$/, "").replace(/\t+| {3,}/g, " | ").trim();
    if (!line) continue;
    const heading = lexiconKey(headingText(line));
    // References and publications list other people (referees, co-authors): left out whole.
    if (heading && line.length <= 60) inReferences = heading === "references" || heading === "publications";
    if (inReferences) {
      references.push(line);
      continue;
    }
    // A bullet belongs to the entry above it: if that entry's header is removed as sensitive,
    // its bullets go too ("Treasurer, Black Student Union" then "- Managed the budget").
    // A section heading is not an entry: the bullets under it stand alone.
    const previous = units[units.length - 1];
    if (isBulletLine(line) && previous && previous.scope === "all") previous.lines.push(line);
    else units.push({ lines: [line], guard: "", scope: isBulletLine(line) || heading ? "each" : "all" });
  }
  const item = withheld(references.join(" · "), WITHHELD_REASON.references);
  if (item) removed.push(item);
  return { sections: [{ heading: "", units }], removed };
}

// -------------------------------------------------------------------------------------------
// Redaction passes
// -------------------------------------------------------------------------------------------

function sensitiveItem(original: string): RedactionItem {
  return { kind: "sensitive", reason: SENSITIVE_REASON, original: clean(original), placeholder: REMOVED_PLACEHOLDER };
}

/** Applies the sensitive rule to one unit; returns the lines to keep (with "[removed]" markers). */
function screenUnit(unit: Unit, removed: RedactionItem[]): string[] {
  const guardHit = unit.guard !== "" && detectSensitive(unit.guard).length > 0;
  if (unit.scope === "all") {
    const hit = guardHit || unit.lines.some((l) => detectSensitive(l).length > 0);
    if (hit) {
      const [first, ...rest] = unit.lines;
      const head = unit.label ?? [first, unit.guard].filter(Boolean).join(", ");
      removed.push(sensitiveItem(rest.length > 0 ? `${head}: ${rest.map((r) => r.replace(/^- /, "")).join("; ")}` : head));
      return [REMOVED_PLACEHOLDER];
    }
    return unit.lines;
  }
  return unit.lines.map((l) => {
    if (detectSensitive(l).length === 0 && !guardHit) return l;
    removed.push(sensitiveItem(l));
    return REMOVED_PLACEHOLDER;
  });
}

/**
 * Folds adjacent removals (blank lines between them included) into one marker, so the text does
 * not reveal how many lines or entries were removed either.
 */
function collapseRemoved(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === REMOVED_PLACEHOLDER || line === `- ${REMOVED_PLACEHOLDER}`) {
      let j = out.length - 1;
      while (j >= 0 && out[j] === "") j--;
      if (j >= 0 && out[j] === REMOVED_PLACEHOLDER) {
        out.length = j + 1;
        continue;
      }
      out.push(REMOVED_PLACEHOLDER);
      continue;
    }
    out.push(line);
  }
  return out;
}

function renderSkills(lines: readonly string[]): string[] {
  // Skills were screened one by one; send them back as one comma-separated line.
  const kept = lines.filter((l) => l !== REMOVED_PLACEHOLDER);
  const out: string[] = kept.length > 0 ? [kept.join(", ")] : [];
  if (kept.length !== lines.length) out.push(REMOVED_PLACEHOLDER);
  return out;
}

function assemble(collected: Collected, removed: RedactionItem[]): string[] {
  const out: string[] = [];
  for (const section of collected.sections) {
    let body: string[] = [];
    for (const unit of section.units) {
      const lines = screenUnit(unit, removed);
      body.push(...lines);
      if (section.heading && section.heading !== "SKILLS" && section.heading !== "EDUCATION" && unit.scope === "all") body.push("");
    }
    if (section.heading === "SKILLS") body = renderSkills(body);
    body = collapseRemoved(body.filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== "")));
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    if (body.length === 0) continue;
    if (out.length > 0) out.push("");
    if (section.heading) out.push(section.heading);
    out.push(...body);
  }
  return out;
}

function redactLines(lines: readonly string[], names: readonly string[], removed: RedactionItem[]): string[] {
  return lines.map((line) => {
    if (!line || line === REMOVED_PLACEHOLDER) return line;
    const r = redactPii(line, { names });
    removed.push(...r.removed);
    return r.text;
  });
}

/** Cuts at a line boundary so no statement is sent half-way. */
function truncate(lines: readonly string[], maxChars: number, removed: RedactionItem[]): string[] {
  let total = 0;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const next = total + line.length + (kept.length > 0 ? 1 : 0);
    if (next > maxChars) {
      const rest = lines.slice(i).filter((l) => l.trim() !== "").join(" ");
      if (rest) removed.push({ kind: "limit", reason: LIMIT_REASON, original: rest.length > 400 ? `${rest.slice(0, 399)}…` : rest, placeholder: "" });
      break;
    }
    kept.push(line);
    total = next;
  }
  while (kept.length > 0 && (kept[kept.length - 1] === "" || /^[A-Z][A-Z ]+$/.test(kept[kept.length - 1] as string))) kept.pop();
  return kept;
}

/**
 * The zero-leak gate: re-runs the detectors over the finished text and fixes anything left
 * (a sensitive line goes whole; a contact detail becomes its placeholder). Lines that still
 * fail after three passes are dropped rather than sent.
 */
function finalGate(lines: string[], names: readonly string[], removed: RedactionItem[]): string[] {
  let current = lines;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    current = current.map((line) => {
      if (!line || line === REMOVED_PLACEHOLDER) return line;
      if (detectSensitive(line).length > 0) {
        changed = true;
        removed.push(sensitiveItem(line));
        return REMOVED_PLACEHOLDER;
      }
      if (detectPii(line, { names }).length > 0) {
        changed = true;
        const r = redactPii(line, { names });
        removed.push(...r.removed);
        return r.text;
      }
      return line;
    });
    if (!changed) break;
  }
  const out = current.filter((line) => !line || line === REMOVED_PLACEHOLDER || (detectSensitive(line).length === 0 && detectPii(line, { names }).length === 0));
  return collapseRemoved(out);
}

/** Name seeds: the parsed name and aliases plus any the caller adds (the account name). */
function nameSeeds(parsed: ParsedResume | null, extra: readonly string[] | undefined): string[] {
  const seeds = [parsed?.contact?.name ?? null, ...(parsed?.contact?.aliases ?? []), ...(extra ?? [])];
  return [...new Set(seeds.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()))];
}

function isParsedResume(v: unknown): v is ParsedResume {
  return !!v && typeof v === "object" && Array.isArray((v as ParsedResume).experience) && Array.isArray((v as ParsedResume).skills);
}

/**
 * Builds the text an AI may read. Pass a ParsedResume for the section allowlist (the normal
 * path), or a string to redact pasted or edited text line by line. Nothing here is sent; the
 * caller shows `text` to the student and sends it only after explicit consent.
 */
export function redactForAi(input: ParsedResume | string, options: RedactOptions = {}): RedactionResult {
  const maxChars = Math.max(200, Math.min(options.maxChars ?? AI_TEXT_MAX_CHARS, AI_TEXT_MAX_CHARS));
  let parsed: ParsedResume | null = null;
  let collected: Collected;
  if (typeof input === "string") {
    // Parse only to learn the name and aliases in the header; the text itself is kept as is.
    parsed = input.trim() ? parseResumeText({ text: input }) : null;
    collected = collectFromText(input);
  } else if (isParsedResume(input)) {
    parsed = input;
    collected = collectFromParsed(input);
  } else {
    return { text: "", removed: [] };
  }
  const names = nameSeeds(parsed, options.names);
  const removed: RedactionItem[] = [...collected.removed];
  let lines = assemble(collected, removed);
  lines = redactLines(lines, names, removed);
  lines = finalGate(lines, names, removed);
  lines = truncate(lines, maxChars, removed);
  return { text: lines.join("\n").trim(), removed: dedupeItems(removed) };
}

function dedupeItems(items: readonly RedactionItem[]): RedactionItem[] {
  const seen = new Set<string>();
  const out: RedactionItem[] = [];
  for (const item of items) {
    const key = `${item.kind}\u0000${item.original.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Server-side recheck
// -------------------------------------------------------------------------------------------

export type AiTextIssue = PiiKind | "sensitive" | "too_long";

export interface AiTextScan {
  ok: boolean;
  /** Coarse kinds only. Never the matched text, never a sensitive category. */
  issues: AiTextIssue[];
}

/**
 * The same detectors, for the server to re-run on text it receives (it never trusts the
 * client). Without the student's name seeds it still catches contact patterns, identifiers,
 * honorific and role names, and sensitive statements. The result carries no resume text, so
 * it is safe to log; the text itself must never be logged.
 */
export function scanAiText(text: string, maxChars: number = AI_TEXT_MAX_CHARS): AiTextScan {
  if (typeof text !== "string") return { ok: false, issues: ["too_long"] };
  const issues = new Set<AiTextIssue>();
  if (text.length > maxChars) issues.add("too_long");
  for (const hit of detectPii(text)) issues.add(hit.kind);
  if (detectSensitive(text).length > 0) issues.add("sensitive");
  const ordered = (["email", "phone", "link", "address", "id", "birthdate", "name", "sensitive", "too_long"] as const).filter((k) => issues.has(k));
  return { ok: ordered.length === 0, issues: ordered };
}

/** Typed placeholders the redactor leaves; detectors never match them. */
export const AI_PLACEHOLDERS: readonly string[] = [...new Set([...Object.values(PII_PLACEHOLDERS), REMOVED_PLACEHOLDER])];
