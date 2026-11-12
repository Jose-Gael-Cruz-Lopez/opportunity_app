/**
 * shared/contracts: the zod schemas every module shares. Convention: `FooSchema` is the zod
 * schema and `Foo` the inferred type. Bodies are `.strict()`, so unknown keys (including any
 * status or identity answer) are rejected rather than silently dropped.
 *
 * SensitiveAnswers is exported for browser code only; it is excluded from the JSON Schema export
 * and from every request schema.
 */
export * from "../taxonomy";
export * from "./common";
export * from "./evidence";
export * from "./registry";
export * from "./student";
export * from "./sensitive";
export * from "./eligibility";
export * from "./readiness";
export * from "./roadmap";
export * from "./events";
export * from "./advisor";
export * from "./ops";
export * from "./ai";
export * from "./extraction.v1";
export * from "./api";
export * from "./internal";
export * from "./routes";
export * from "./json-schema";
export * from "./schema-registry";
