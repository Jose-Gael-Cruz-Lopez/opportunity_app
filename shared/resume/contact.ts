import type { LogicalLine } from "./layout";
import { NOT_A_NAME } from "./lexicon/names";
import { cityStateRegex } from "./lexicon/places";
import { hasInstitutionWord, hasOrgWord, hasRoleWord } from "./lexicon/roles";
import { detectPii } from "./pii";
import { lexiconKey } from "./sections";
import { foldForMatch, isAllCaps, splitCells, trimPunctuation } from "./text";
import type { ResumeContact, ResumeHints, ResumeLink, ResumeLinkKind } from "./types";

/**
 * Contact details and links, kept on the device. The name is picked by additive feature
 * scoring over the profile lines (the weights OpenResume documents, plus Novus's own: largest
 * font on page one, first line, two to four words, matches the PDF author or account name).
 */

const NAME_SHAPE = /^\p{L}[\p{L}.' -]*$/u;

interface NameContext {
  firstIndex: number;
  maxFont: number | null;
  hints: string[];
}

export function scoreNameCandidate(cell: string, line: LogicalLine, ctx: NameContext): number {
  const t = cell.trim();
  if (!t || t.length > 60) return -Infinity;
  let s = 0;
  if (NAME_SHAPE.test(t)) s += 3;
  if (line.bold) s += 2;
  if (isAllCaps(t)) s += 2;
  if (ctx.maxFont !== null && line.fontSize !== null && line.page === 1 && line.fontSize >= ctx.maxFont - 0.01) s += 3;
  if (line.index === ctx.firstIndex) s += 2;
  const tokens = t.split(/\s+/).length;
  if (tokens >= 2 && tokens <= 4) s += 1;
  else if (tokens === 1) s -= 1;
  else s -= 3;
  if (t.includes("@")) s -= 4;
  if (/\d/.test(t)) s -= 4;
  if (t.includes(",")) s -= 4;
  if (/[/\\|]/.test(t)) s -= 4;
  const folded = foldForMatch(t);
  if (ctx.hints.some((h) => foldForMatch(h) === folded)) s += 3;
  if (lexiconKey(t) || hasRoleWord(t) || hasOrgWord(t) || hasInstitutionWord(t)) s -= 4;
  if (cityStateRegex().test(t)) s -= 4;
  if (/^(?:resume|résumé|cv|curriculum\s+vitae|contact|portfolio)$/i.test(t)) s -= 10;
  return s;
}

function looksLikeName(s: string | null | undefined): s is string {
  if (!s) return false;
  const t = s.trim();
  if (!t || NOT_A_NAME.test(t)) return false;
  const tokens = t.split(/\s+/);
  return NAME_SHAPE.test(t) && tokens.length >= 2 && tokens.length <= 4;
}

/** "Jane_Doe_Resume_2026.pdf" -> "Jane Doe". */
export function nameFromFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  const tokens = base
    .split(/[\s_.\-()[\]]+/)
    .filter((t) => /^\p{L}{2,}$/u.test(t) && !/^(?:resume|résumé|cv|final|draft|updated|copy|new|latest|version|v|my|the|internship|application|template|doc|docx|pdf)$/i.test(t));
  return tokens.length >= 2 && tokens.length <= 3 ? tokens.join(" ") : null;
}

/** Aliases from the email local part and profile slugs: jane.doe -> "jane doe", github.com/janedoe -> "janedoe". */
function aliasesFrom(email: string | null, links: readonly ResumeLink[]): string[] {
  const out: string[] = [];
  if (email) {
    const local = email.split(/@|\s*(?:\[|\()?\s*at\s*(?:\]|\))?\s+/i)[0] ?? "";
    const parts = local.split(/[._\-+\d]+/).filter((p) => /^\p{L}{2,}$/u.test(p));
    if (parts.length >= 2) out.push(parts.slice(0, 3).join(" "));
    else if (parts[0] && parts[0].length >= 4) out.push(parts[0]);
  }
  for (const link of links) {
    const li = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(link.url);
    if (li && li[1]) {
      const parts = li[1].split(/[-_]+/).filter((p) => /^\p{L}{2,}$/u.test(p));
      if (parts.length >= 2) out.push(parts.join(" "));
      else if (parts[0] && parts[0].length >= 4) out.push(parts[0]);
    }
    const gh = /github\.com\/([A-Za-z0-9-]{3,39})/i.exec(link.url) ?? /^@([A-Za-z0-9_.]{3,30})$/.exec(link.url) ?? /([A-Za-z0-9-]{3,39})\.github\.io/i.exec(link.url);
    if (gh && gh[1]) out.push(gh[1]);
  }
  return out;
}

function linkKind(url: string): ResumeLinkKind {
  if (/linkedin\.com/i.test(url)) return "linkedin";
  if (/github\.com/i.test(url)) return "github";
  if (/^@/.test(url)) return "other";
  if (/(?:github\.io|vercel\.app|netlify\.app|pages\.dev|wixsite\.com|squarespace\.com|carrd\.co|about\.me|notion\.site|\.dev\b|\.me\b|\.io\b|\.design\b|\.page\b|\.site\b|portfolio)/i.test(url)) return "portfolio";
  return "other";
}

export interface ContactResult {
  contact: ResumeContact;
  links: ResumeLink[];
}

export function extractContact(profile: readonly LogicalLine[], all: readonly LogicalLine[], hints: ResumeHints = {}): ContactResult {
  const ordered = [...profile, ...all.filter((l) => !profile.includes(l))];
  let email: string | null = null;
  let phone: string | null = null;
  const links: ResumeLink[] = [];
  for (const line of ordered) {
    for (const hit of detectPii(line.text)) {
      if (hit.kind === "email" && !email) email = hit.match.trim();
      else if (hit.kind === "phone" && !phone) phone = hit.match.trim();
      else if (hit.kind === "link" && !links.some((l) => l.url === hit.match)) links.push({ url: hit.match, kind: linkKind(hit.match) });
    }
  }

  for (const raw of hints.links ?? []) {
    if (typeof raw !== "string") continue;
    const url = raw.trim();
    if (/^mailto:/i.test(url)) {
      email ??= url.replace(/^mailto:/i, "").split("?")[0] || null;
      continue;
    }
    if (/^https?:\/\//i.test(url) && !links.some((l) => l.url === url)) links.push({ url, kind: linkKind(url) });
  }

  let location: string | null = null;
  for (const line of profile) {
    const m = cityStateRegex().exec(line.text);
    if (m) {
      // "City, ST" is enough for the review screen; a ZIP code narrows it to a neighbourhood.
      location = m[0].replace(/\s+\d{5}(?:-\d{4})?$/, "").trim();
      break;
    }
  }

  const hintNames = [hints.author, hints.accountName].filter(looksLikeName);
  const fromFile = nameFromFileName(hints.fileName);
  // Without a header block there is no name line to find; guessing from section content would
  // pick a heading or a project title.
  const candidates = profile;
  const page1 = all.filter((l) => l.page === 1 && l.fontSize !== null).map((l) => l.fontSize as number);
  const ctx: NameContext = {
    firstIndex: all[0]?.index ?? 0,
    maxFont: page1.length > 0 ? Math.max(...page1) : null,
    hints: fromFile ? [...hintNames, fromFile] : hintNames,
  };
  let best: { name: string; score: number } | null = null;
  for (const line of candidates.slice(0, 8)) {
    for (const cell of splitCells(line.text)) {
      // "Name: Tomás Herrera" on resumes typed into a form.
      const clean = trimPunctuation(cell.replace(/^\s*(?:full\s+|legal\s+)?name\s*:\s*/i, ""));
      const score = scoreNameCandidate(clean, line, ctx);
      if (score > 0 && (!best || score > best.score)) best = { name: clean, score };
    }
  }
  const name = best?.name ?? null;

  const aliasPool = [...hintNames, ...(fromFile ? [fromFile] : []), ...aliasesFrom(email, links)];
  const seen = new Set<string>(name ? [foldForMatch(name)] : []);
  const aliases: string[] = [];
  for (const a of aliasPool) {
    const key = foldForMatch(a.trim());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(a.trim());
  }
  return { contact: { name, email, phone, location, aliases }, links };
}
