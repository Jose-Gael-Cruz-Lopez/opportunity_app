/**
 * shared/taxonomy: every enum the registry, eligibility, readiness, pipeline and LLM schemas share.
 * Declare an enum here once and import it; a second declaration elsewhere is a bug.
 */
export * from "./opportunity-types";
export * from "./students";
export * from "./fields-of-study";
export * from "./registry";
export * from "./sensitive";
export * from "./terms";
