import { DISCLOSURE } from "./config";

/** Labels released counts carry, and what each label tells a reader about the count behind it. */

export const NOT_SHOWN = "not shown";
export const fewerThan = (minCell: number): string => `fewer than ${minCell}`;

/** R5: bands below 20 ("5-9", "10-19"), otherwise rounded to the nearest 5. */
export function countLabel(n: number): string {
  if (n < 10) return "5-9";
  if (n < DISCLOSURE.bandBelow) return "10-19";
  return String(Math.round(n / DISCLOSURE.roundTo) * DISCLOSURE.roundTo);
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

export const UNBOUNDED = Number.POSITIVE_INFINITY;

/** The interval a label guarantees: exactly what an attacker learns from the label alone. */
export function labelBounds(label: string): Interval {
  if (label === NOT_SHOWN) return { lo: 0, hi: UNBOUNDED };
  const fewer = /^fewer than (\d+)$/.exec(label);
  if (fewer) return { lo: 0, hi: Number(fewer[1]) - 1 };
  const band = /^(\d+)-(\d+)$/.exec(label);
  if (band) return { lo: Number(band[1]), hi: Number(band[2]) };
  const n = Number(label);
  if (!Number.isInteger(n)) throw new RangeError(`unknown label ${label}`);
  // Rounded to the nearest 5 and only used from 20 up.
  const half = Math.floor(DISCLOSURE.roundTo / 2);
  return { lo: Math.max(DISCLOSURE.bandBelow, n - half), hi: n + half };
}

export function isHiddenLabel(label: string): boolean {
  return label === NOT_SHOWN || label.startsWith("fewer than");
}
