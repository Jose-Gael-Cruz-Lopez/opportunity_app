import { z } from "zod";

/**
 * Major families with a crosswalk from two-digit CIP 2020 series. The crosswalk is Novus's own
 * grouping for filters and ranking, not an official NCES grouping. CIP series 30
 * (multi/interdisciplinary) maps to no family on purpose: eligibility treats it as borderline.
 */

export const MAJOR_FAMILIES = [
  "agriculture_environment",
  "arts_design",
  "business",
  "communication_media",
  "computing",
  "education",
  "engineering_technology",
  "health",
  "humanities_languages",
  "life_sciences",
  "math_statistics",
  "physical_sciences",
  "social_sciences",
  "law_policy_service",
  "trades_applied",
  "undeclared",
] as const;
export const MajorFamilySchema = z.enum(MAJOR_FAMILIES);
export type MajorFamily = z.infer<typeof MajorFamilySchema>;

export const MAJOR_FAMILY_LABELS: Record<MajorFamily, string> = {
  agriculture_environment: "Agriculture and environment",
  arts_design: "Arts and design",
  business: "Business",
  communication_media: "Communication and media",
  computing: "Computing",
  education: "Education",
  engineering_technology: "Engineering and technology",
  health: "Health",
  humanities_languages: "Humanities and languages",
  life_sciences: "Life sciences",
  math_statistics: "Math and statistics",
  physical_sciences: "Physical sciences",
  social_sciences: "Social sciences",
  law_policy_service: "Law, policy and public service",
  trades_applied: "Trades and applied fields",
  undeclared: "Undeclared",
};

/** Two-digit CIP 2020 series per family. */
export const MAJOR_FAMILY_CIP_SERIES: Record<MajorFamily, readonly string[]> = {
  agriculture_environment: ["01", "03"],
  arts_design: ["04", "50"],
  business: ["52"],
  communication_media: ["09", "10"],
  computing: ["11"],
  education: ["13"],
  engineering_technology: ["14", "15"],
  health: ["51", "60", "61"],
  humanities_languages: ["05", "16", "23", "24", "25", "38", "39", "54"],
  life_sciences: ["26"],
  math_statistics: ["27"],
  physical_sciences: ["40", "41"],
  social_sciences: ["19", "42", "45"],
  law_policy_service: ["22", "28", "29", "43", "44"],
  trades_applied: ["12", "31", "46", "47", "48", "49"],
  undeclared: [],
};

/** CIP codes are "NN", "NN.NN" or "NN.NNNN". */
export const CIP_CODE_PATTERN = /^\d{2}(\.\d{2}(\d{2})?)?$/;
export const CipCodeSchema = z.string().regex(CIP_CODE_PATTERN, "CIP code like 11.0701");
export type CipCode = z.infer<typeof CipCodeSchema>;

/** Returns the family for a CIP code, or null when the series is unmapped (treated as borderline). */
export function majorFamilyForCip(cip: string): MajorFamily | null {
  if (!CIP_CODE_PATTERN.test(cip)) return null;
  const series = cip.slice(0, 2);
  for (const family of MAJOR_FAMILIES) {
    if (MAJOR_FAMILY_CIP_SERIES[family].includes(series)) return family;
  }
  return null;
}

/** True when `cip` falls under `prefix` (prefix match on the dotted code). */
export function cipMatchesPrefix(cip: string, prefix: string): boolean {
  return cip === prefix || cip.startsWith(prefix.length === 2 ? `${prefix}.` : prefix);
}
