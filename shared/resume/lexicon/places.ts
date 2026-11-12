import { US_STATES } from "../../taxonomy";

/**
 * Place patterns for locations in entry headers ("Ithaca, NY") and for address redaction.
 * State codes come from shared/taxonomy; full state names are listed here because the
 * taxonomy keeps codes only.
 */

export const US_STATE_NAMES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Puerto Rico", "Rhode Island", "South Carolina", "South Dakota", "Tennessee",
  "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
] as const;

/** Countries students commonly write after a city. Short on purpose: it only shapes locations. */
export const COUNTRY_NAMES = [
  "USA", "U.S.A.", "United States", "Canada", "Mexico", "United Kingdom", "UK", "England", "Ireland",
  "France", "Germany", "Spain", "Italy", "Netherlands", "Switzerland", "India", "China", "Japan",
  "South Korea", "Korea", "Singapore", "Australia", "Brazil", "Nigeria", "Kenya", "Ghana",
] as const;

const CODES = US_STATES.join("|");
const STATE_NAMES = US_STATE_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|");
const COUNTRIES = COUNTRY_NAMES.map((n) => n.replace(/\./g, "\\.").replace(/ /g, "\\s+")).join("|");

/**
 * One to four capitalized words, as in "San Luis Obispo" or "St. Louis". Words are joined by
 * one space only: a tab or a run of spaces separates cells, so "Ohio State University<tab>
 * Columbus, OH" or "College of Engineering      Ann Arbor, MI" must not read as one city.
 */
const CITY = "(?<![\\p{L}\\p{N}])\\p{Lu}[\\p{L}.'-]*(?: \\p{Lu}[\\p{L}.'-]*){0,3}";
const ZIP = "(?: +\\d{5}(?:-\\d{4})?)?";

/** "City, ST" or "City, ST 12345" (state codes are matched case-sensitively). */
export const CITY_STATE_SOURCE = `${CITY},\\s*(?:${CODES})(?![\\p{L}])${ZIP}`;
/** "City, State" with the state's full name. */
export const CITY_STATE_NAME_SOURCE = `${CITY},\\s*(?:${STATE_NAMES})(?![\\p{L}])${ZIP}`;
/** "City, Country". */
export const CITY_COUNTRY_SOURCE = `${CITY},\\s*(?:${COUNTRIES})(?![\\p{L}])`;
/** Work-mode words that stand in for a location in entry headers. */
export const WORK_MODE_SOURCE = "(?<![\\p{L}])(?:Remote|Hybrid|On-?site|In-?person|Virtual|Online)(?![\\p{L}])";

/**
 * In an entry header a place ends its cell: end of line, a separator, a wide gap or a ZIP.
 * "Peer Tutor, UT Learning Center" is a role and an organization, not a town in Utah.
 */
const CELL_END = "(?=\\s{2,}|\\s*(?:$|[|,;·•\\t)\\]/-]|\\d{5}))";

/**
 * A fresh global regex for any location form in entry headers (fresh, so callers never share
 * lastIndex). Stricter than cityStateRegex: parsing wants precision here, redaction recall.
 */
export function locationRegex(): RegExp {
  return new RegExp(`(?:${CITY_STATE_SOURCE}|${CITY_STATE_NAME_SOURCE}|${CITY_COUNTRY_SOURCE})${CELL_END}|${WORK_MODE_SOURCE}`, "gu");
}

/** A fresh global regex for "City, ST" and "City, State" only (used by address redaction). */
export function cityStateRegex(): RegExp {
  return new RegExp(`${CITY_STATE_SOURCE}|${CITY_STATE_NAME_SOURCE}`, "gu");
}
