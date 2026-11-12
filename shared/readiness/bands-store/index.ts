/**
 * shared/readiness/bands-store: the per-program storage shape of band models and the gates
 * readiness checks at read time. Pure; imports only its own files.
 */
export { BANDS_STORE_CONFIG } from "./config";
export { bandModelKey, HELD_OUT_OUTCOMES, sliceModelForProgram, splitModelByProgram } from "./rows";
export type { BandModelShape, HeldOutOutcome, ProgramBandRow, ProgramEntryShape, StoredGateFlags } from "./rows";
export { BAND_READ_FAILURES, daysBetween, decideProgramBand, everyGatePasses, fittedGateFailures, rowFailures } from "./gates";
export type { BandReadContext, BandReadDecision, BandReadFailure, BandTransition } from "./gates";
