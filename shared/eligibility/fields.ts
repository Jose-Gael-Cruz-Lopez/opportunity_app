import { getEligibilityField, type EligibilityFieldKey } from "../contracts/eligibility";
import type { StudentProfile } from "../contracts/student";
import { GPA_BAND_BOUNDS, type ClassYear, type GpaBand } from "../taxonomy";
import { parseTermKey } from "../time/terms";
import { ANYTHING, known, oneOf, range, type AbstractValue, type Primitive } from "./abstract";
import type { EvalContext } from "./context";
import { isCountableCalendar, possibleAges, projectClassYear, semesterEquivalentsRemaining, type CountableCalendar } from "./standing";

/**
 * The field environment: reads one catalogue field for a rule and says how certain the answer is.
 * Status drives the reason a rule gives when it ends up unknown, and who can resolve it.
 */
export type FieldStatus =
  /** Exactly known. */
  | "known"
  /** The student has not answered (or answered "not sure" / "prefer not"). Resolver: student. */
  | "missing"
  /** Answered coarsely: a GPA band or a birth month that may straddle a limit. Resolver: student. */
  | "coarse"
  /** Converted from a quarter or trimester calendar; never yields "yes". Resolver: student. */
  | "calendar"
  /** Institution can nominate is not on record. Resolver: student. */
  | "participation"
  /** Two profile answers disagree (class year and graduation term). Resolver: student. */
  | "conflict"
  /** Novus lacks a date or institution fact the rule needs. Resolver: novus. */
  | "context"
  /** A sensitive answer was not given on the device. Resolver: student. */
  | "sensitive_missing"
  /** A sensitive field outside the device: never read, always unknown. */
  | "sensitive_withheld";

export interface FieldReading {
  readonly value: AbstractValue;
  readonly status: FieldStatus;
  /** Catalogue fields whose absence caused the uncertainty (names only, never values). */
  readonly blame: readonly EligibilityFieldKey[];
}

/** Sensitive answers as the device supplies them; the server never constructs one of these. */
export interface DeviceInputs {
  /** A sensitive field's answer: an enum value, or an array for identity categories. */
  readonly sensitiveValue: (field: EligibilityFieldKey) => string | readonly string[] | undefined;
  /** true confirmed, false declined, undefined not answered. */
  readonly attestation: (id: string) => boolean | undefined;
}

export type EligibilityProfile = Readonly<Partial<StudentProfile>>;

export interface FieldEnvInput {
  readonly profile: EligibilityProfile;
  readonly context: EvalContext;
  /** The evaluation date (YYYY-MM-DD); rules with asOf "today" are judged at it. */
  readonly today: string;
  readonly device?: DeviceInputs;
}

/**
 * Date-dependent fields read at the rule's anchor. `anchor` is null when the rule names an
 * anchor (campus_deadline, national_deadline, program_start) that the context does not have.
 */
export function readField(key: EligibilityFieldKey, env: FieldEnvInput, anchor: string | null): FieldReading {
  const def = getEligibilityField(key);
  if (!def) throw new RangeError(`unknown field ${key}`);
  if (def.sensitive) return readSensitive(key, env);
  const p = env.profile;
  switch (key) {
    case "classYear":
      return readClassYear(env, anchor);
    case "semestersRemaining":
    case "yearsRemaining":
      return readStanding(key, env, anchor);
    case "expectedGraduationTerm":
      return p.expectedGraduationTerm ? ok(known(p.expectedGraduationTerm)) : missing(ANYTHING, key);
    case "expectedGraduationYear": {
      const t = p.expectedGraduationTerm ? parseTermKey(p.expectedGraduationTerm) : null;
      return t ? ok(known(t.year)) : missing(ANYTHING, "expectedGraduationTerm");
    }
    case "institutionLevel":
      return readEnum(key, env.context.institution?.level ?? p.institutionLevel ?? null);
    case "enrollmentIntensity":
    case "transferIntent":
    case "gpaBand":
    case "majorFamily":
    case "residenceState":
      return readEnum(key, (p[key] as string | null | undefined) ?? null);
    case "gpaMin":
    case "gpaMax":
      return readGpa(p.gpaBand ?? null);
    case "majorCip":
    case "minorCip":
      return p[key] ? ok(known(p[key] as string)) : missing(ANYTHING, key);
    case "institutionId": {
      const id = env.context.institution?.id ?? p.institutionId ?? null;
      return id ? ok(known(id)) : missing(ANYTHING, key);
    }
    case "institutionParticipates":
      return readParticipation(env);
    case "ageAtAsOf":
      return readAge(env, anchor);
    default:
      throw new RangeError(`no reader for field ${key}`);
  }
}

/** Whether a field has an answer at all (for JsonLogic `missing`). */
export function isAnswered(reading: FieldReading): boolean {
  return reading.status !== "missing" && reading.status !== "sensitive_missing" && reading.status !== "sensitive_withheld";
}

function ok(value: AbstractValue): FieldReading {
  return { value, status: "known", blame: [] };
}

function missing(value: AbstractValue, ...blame: EligibilityFieldKey[]): FieldReading {
  return { value, status: "missing", blame };
}

function context(): FieldReading {
  return { value: ANYTHING, status: "context", blame: [] };
}

/** The real values of an enum field, without its "not answered" values. */
function universe(key: EligibilityFieldKey): readonly string[] {
  const def = getEligibilityField(key);
  const unknownValues = new Set(def?.unknownValues ?? []);
  return (def?.values ?? []).filter((v) => !unknownValues.has(v));
}

/** An unanswered enum is "one of its real values", which keeps rules exact (see evaluate.ts). */
function readEnum(key: EligibilityFieldKey, value: string | null): FieldReading {
  const def = getEligibilityField(key);
  const unanswered = value === null || (def?.unknownValues ?? []).includes(value);
  if (!unanswered) return ok(known(value));
  const all = universe(key);
  return missing(all.length > 0 ? oneOf(all as Primitive[]) : ANYTHING, key);
}

function readGpa(band: GpaBand | null): FieldReading {
  const bounds = band ? GPA_BAND_BOUNDS[band] : null;
  if (!bounds) return missing(ANYTHING, "gpaBand");
  // Bands are [min, max): the student's GPA is somewhere inside, so a floor inside the band is unknown.
  return { value: range(bounds.min, bounds.max, { hiOpen: true }), status: "coarse", blame: [] };
}

function readParticipation(env: FieldEnvInput): FieldReading {
  const inst = env.context.institution;
  if (!inst && !env.profile.institutionId) return missing(ANYTHING, "institutionId");
  if (inst?.participates === true) return ok(known(true));
  return { value: ANYTHING, status: "participation", blame: [] };
}

function calendarOf(env: FieldEnvInput): { calendar: CountableCalendar | null; reading: FieldReading | null } {
  const inst = env.context.institution;
  if (!inst) return { calendar: null, reading: missing(ANYTHING, "institutionId") };
  if (inst.calendar === null) return { calendar: null, reading: context() };
  if (!isCountableCalendar(inst.calendar)) return { calendar: null, reading: { value: ANYTHING, status: "calendar", blame: [] } };
  return { calendar: inst.calendar, reading: null };
}

function readStanding(key: "semestersRemaining" | "yearsRemaining", env: FieldEnvInput, anchor: string | null): FieldReading {
  if (anchor === null) return context();
  const grad = env.profile.expectedGraduationTerm ?? null;
  const { calendar, reading } = calendarOf(env);
  if (!grad) return missing(ANYTHING, "expectedGraduationTerm", ...(reading?.blame ?? []));
  if (reading) return reading;
  const eq = semesterEquivalentsRemaining(grad, anchor, calendar as CountableCalendar);
  const scale = key === "yearsRemaining" ? 0.5 : 1;
  if (eq.exact) return ok(known(eq.lo * scale));
  return { value: range(eq.lo * scale, eq.hi * scale), status: "calendar", blame: [] };
}

function readClassYear(env: FieldEnvInput, anchor: string | null): FieldReading {
  const reported = env.profile.classYear ?? null;
  if (reported === null) return readEnum("classYear", null);
  if (anchor === null) return context();
  if (anchor === env.today) return ok(known(reported));
  const inst = env.context.institution;
  const calendar = inst?.calendar && isCountableCalendar(inst.calendar) ? inst.calendar : "semester";
  const projected = projectClassYear({
    reported,
    today: env.today,
    anchor,
    gradTerm: env.profile.expectedGraduationTerm ?? null,
    calendar,
    academicYearStartMonth: inst?.academicYearStartMonth ?? 8,
  });
  const possible: readonly ClassYear[] = projected.years;
  if (projected.conflict) return { value: oneOf(possible as Primitive[]), status: "conflict", blame: ["classYear", "expectedGraduationTerm"] };
  if (possible.length === 1) return ok(known(possible[0] as string));
  return missing(oneOf(possible as Primitive[]), "expectedGraduationTerm");
}

function readAge(env: FieldEnvInput, anchor: string | null): FieldReading {
  const birth = env.profile.birthYearMonth ?? null;
  if (!birth) return missing(ANYTHING, "ageAtAsOf");
  if (anchor === null) return context();
  const ages = possibleAges(birth, anchor);
  if (ages.length === 1) return ok(known(ages[0] as number));
  return { value: oneOf(ages as Primitive[]), status: "coarse", blame: [] };
}

function readSensitive(key: EligibilityFieldKey, env: FieldEnvInput): FieldReading {
  if (!env.device) return { value: ANYTHING, status: "sensitive_withheld", blame: [key] };
  const def = getEligibilityField(key);
  const answer = env.device.sensitiveValue(key);
  const unknownValues = def?.unknownValues ?? [];
  if (def?.valueType === "enum_list") {
    if (answer === undefined || typeof answer === "string") return { value: ANYTHING, status: "sensitive_missing", blame: [key] };
    if (answer.some((v) => unknownValues.includes(v))) return { value: ANYTHING, status: "sensitive_missing", blame: [key] };
    return ok(known([...answer]));
  }
  if (typeof answer === "string" && !unknownValues.includes(answer)) return ok(known(answer));
  const all = universe(key);
  return { value: all.length > 0 ? oneOf(all as Primitive[]) : ANYTHING, status: "sensitive_missing", blame: [key] };
}
