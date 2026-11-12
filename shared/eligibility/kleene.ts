import type { EligibilityVerdict } from "../contracts/eligibility";

/**
 * Strong Kleene three-valued logic, encoded as numbers so the folds are min and max:
 * NO = -1, UNKNOWN = 0, YES = 1. min and max are commutative and associative, so the order of
 * rules and groups never changes a result, and they are monotone in the information order
 * (UNKNOWN below YES and NO): replacing an UNKNOWN input with YES or NO can never flip an
 * existing YES into NO or the reverse. That is why the server, which knows less than the
 * browser, can only ever return a less specific answer, never a contradicting one.
 */
export type Tri = -1 | 0 | 1;

export const NO: Tri = -1;
export const UNKNOWN: Tri = 0;
export const YES: Tri = 1;

/** Conjunction: NO if any member is NO, else UNKNOWN if any is UNKNOWN, else YES (empty: YES). */
export function and3(values: Iterable<Tri>): Tri {
  let result: Tri = YES;
  for (const v of values) if (v < result) result = v;
  return result;
}

/** Disjunction: YES if any member is YES, else UNKNOWN if any is UNKNOWN, else NO (empty: NO). */
export function or3(values: Iterable<Tri>): Tri {
  let result: Tri = NO;
  for (const v of values) if (v > result) result = v;
  return result;
}

export function not3(value: Tri): Tri {
  return value === UNKNOWN ? UNKNOWN : value === YES ? NO : YES;
}

/**
 * Folds the verdicts of several possible worlds (one per combination of possible answers):
 * YES only if every world says YES, NO only if every world says NO, otherwise UNKNOWN.
 */
export function agree3(values: Iterable<Tri>): Tri {
  let sawYes = false;
  let sawNo = false;
  for (const v of values) {
    if (v === UNKNOWN) return UNKNOWN;
    if (v === YES) sawYes = true;
    else sawNo = true;
    if (sawYes && sawNo) return UNKNOWN;
  }
  if (sawYes) return YES;
  return sawNo ? NO : UNKNOWN;
}

export function triFromBoolean(value: boolean): Tri {
  return value ? YES : NO;
}

const VERDICT_BY_TRI: Record<Tri, EligibilityVerdict> = { [-1]: "not_met", 0: "unknown", 1: "met" };
const TRI_BY_VERDICT: Record<EligibilityVerdict, Tri> = { not_met: NO, unknown: UNKNOWN, met: YES };

export function triToVerdict(value: Tri): EligibilityVerdict {
  return VERDICT_BY_TRI[value];
}

export function verdictToTri(verdict: EligibilityVerdict): Tri {
  return TRI_BY_VERDICT[verdict];
}
