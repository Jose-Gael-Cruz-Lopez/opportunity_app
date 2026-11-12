import { findDates, type ResumeNow } from "./dates";
import type { Entry } from "./entries";
import { lookupSkill, mineSkills, normalizeSkills } from "./skills";
import { splitCells, splitList, trimPunctuation, uniqueBy, wordCount } from "./text";
import type { ProjectEntry } from "./types";

/**
 * Projects: a name, the tools used (from a tech-stack cell, a "(React, Firebase)" aside, a
 * "Technologies:" line, or known skills named in the bullets), dates, a description and a
 * link. The link stays on the device.
 */

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![\w.@/-])(?:[a-z0-9-]+\.)+(?:com|io|dev|app|me|org|net|ai|co|page|site|github\.io|vercel\.app|netlify\.app)(?:\/[^\s<>"'`]*)?/gi;
const TECH_LABEL = /^\s*(?:tech(?:nologies|nology)?(?:\s+stack)?|stack|tools(?:\s+used)?|built\s+(?:with|using)|languages?|skills|frameworks?)\s*[:-]\s*(.+)$/i;

/** A cell is a tech list when most of its comma-separated items are known skills. */
function techItems(cell: string): string[] | null {
  const label = TECH_LABEL.exec(cell);
  const body = label && label[1] ? label[1] : cell;
  const items = splitList(body, /[,;/•·]/);
  if (items.length === 0) return null;
  const known = items.filter((i) => lookupSkill(i)).length;
  if (label || (items.length >= 2 && known / items.length >= 0.5) || (items.length === 1 && known === 1 && cell.length <= 20)) return items;
  return null;
}

function firstUrl(texts: readonly string[]): string | null {
  for (const t of texts) {
    URL_IN_TEXT.lastIndex = 0;
    const m = URL_IN_TEXT.exec(t);
    if (m) return m[0].replace(/[.,;:!?)\]}'"]+$/, "");
  }
  return null;
}

export function parseProjectEntry(entry: Entry, now: ResumeNow): ProjectEntry | null {
  const headerTexts = entry.header.map((l) => l.text);
  const url = firstUrl([...headerTexts, ...entry.bullets]);
  let startDate: string | null = null;
  let endDate: string | null = null;
  const keywords: string[] = [];
  let name: string | null = null;
  let description: string | null = null;

  for (const text of headerTexts) {
    const dates = findDates(text, now);
    if (dates[0] && !startDate && !endDate) {
      startDate = dates[0].start;
      endDate = dates[0].end;
    }
    let rest = text;
    for (const d of dates) rest = rest.replace(d.text, "\t");
    rest = rest.replace(URL_IN_TEXT, "\t");
    for (const cell of splitCells(rest)) {
      const clean = trimPunctuation(cell);
      if (!clean || !/\p{L}/u.test(clean)) continue;
      const tech = techItems(clean);
      if (tech && (name !== null || TECH_LABEL.test(clean))) {
        keywords.push(...tech);
        continue;
      }
      if (name === null) {
        const aside = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(clean);
        const asideTech = aside && aside[2] ? techItems(aside[2]) : null;
        if (aside && aside[1] && asideTech) {
          name = trimPunctuation(aside[1]);
          keywords.push(...asideTech);
        } else name = clean;
      } else if (wordCount(clean) >= 3 && description === null) {
        // "Budget Buddy - a Python app that sorts transactions": the cell after the name.
        description = clean;
      }
    }
  }

  const highlights: string[] = [];
  for (const b of entry.bullets) {
    const label = TECH_LABEL.exec(b);
    if (label && label[1]) keywords.push(...splitList(label[1], /[,;/•·]/));
    else highlights.push(b);
  }
  description ??= entry.notes[0] ?? null;
  const notes = description === entry.notes[0] ? entry.notes.slice(1) : entry.notes;
  keywords.push(...mineSkills([description ?? "", ...highlights, ...entry.notes].join("\n")));
  const normalized = uniqueBy(normalizeSkills(keywords), (s) => s.id).map((s) => s.name);
  if (!name && highlights.length === 0 && !description) return null;
  return {
    name,
    description,
    highlights: [...highlights, ...notes],
    keywords: normalized,
    startDate,
    endDate,
    url,
  };
}
