import { z } from "zod";

/**
 * Terms and cycle keys. A cycle key is `{term}-{year}` (`summer-2027`, `year-2027`,
 * `rolling-2027`) or `ay-{year}-{yy}` for awards that fund an academic year (`ay-2027-28`).
 */

export const TERMS = ["spring", "summer", "fall", "winter", "year", "rolling", "ay"] as const;
export const TermSchema = z.enum(TERMS);
export type Term = z.infer<typeof TermSchema>;

/** Academic terms a student can graduate in or plan around (no `year`, `rolling`, `ay`). */
export const ACADEMIC_TERMS = ["winter", "spring", "summer", "fall"] as const;
export const AcademicTermSchema = z.enum(ACADEMIC_TERMS);
export type AcademicTerm = z.infer<typeof AcademicTermSchema>;

export const CYCLE_KEY_PATTERN = /^(?:(spring|summer|fall|winter|year|rolling)-(\d{4})|ay-(\d{4})-(\d{2}))$/;
export const CycleKeySchema = z
  .string()
  .regex(CYCLE_KEY_PATTERN, "cycle key like summer-2027 or ay-2027-28")
  .refine((key) => {
    const ay = /^ay-(\d{4})-(\d{2})$/.exec(key);
    return !ay || (Number(ay[1]) + 1) % 100 === Number(ay[2]);
  }, "academic-year key must span consecutive years");
export type CycleKey = z.infer<typeof CycleKeySchema>;

/** A graduation or planning term such as `spring-2029`. */
export const TERM_KEY_PATTERN = /^(winter|spring|summer|fall)-(\d{4})$/;
export const TermKeySchema = z.string().regex(TERM_KEY_PATTERN, "term key like spring-2029");
export type TermKey = z.infer<typeof TermKeySchema>;

export const TERM_LABELS: Record<Term, string> = {
  spring: "Spring",
  summer: "Summer",
  fall: "Fall",
  winter: "Winter",
  year: "Calendar year",
  rolling: "Rolling",
  ay: "Academic year",
};
