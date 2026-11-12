import type { z } from "zod";
import * as ai from "./ai";
import * as advisor from "./advisor";
import * as api from "./api";
import * as common from "./common";
import * as eligibility from "./eligibility";
import * as events from "./events";
import * as evidence from "./evidence";
import * as extraction from "./extraction.v1";
import * as internal from "./internal";
import * as ops from "./ops";
import * as readiness from "./readiness";
import * as registry from "./registry";
import * as roadmap from "./roadmap";
import * as student from "./student";

/**
 * Schemas published as JSON Schema for the Python pipeline and for model output. SensitiveAnswers
 * is deliberately absent: it never leaves the browser, so no other runtime gets a type for it.
 */
export const JSON_SCHEMA_EXPORTS = {
  // common
  ProblemDetails: common.ProblemDetailsSchema,
  CursorQuery: common.CursorQuerySchema,
  // registry and evidence
  Organization: registry.OrganizationSchema,
  Program: registry.ProgramSchema,
  ProgramCycle: registry.ProgramCycleSchema,
  Deadline: registry.DeadlineSchema,
  Requirement: registry.RequirementSchema,
  Institution: registry.InstitutionSchema,
  ProgramCycleCount: registry.ProgramCycleCountSchema,
  StageOdds: registry.StageOddsSchema,
  ProgramCard: registry.ProgramCardSchema,
  ProgramDetail: registry.ProgramDetailSchema,
  ReleaseArtifact: registry.ReleaseArtifactSchema,
  Source: evidence.SourceSchema,
  Snapshot: evidence.SnapshotSchema,
  FieldEvidence: evidence.FieldEvidenceSchema,
  EvidenceQuote: evidence.EvidenceQuoteSchema,
  EvidenceLocator: evidence.EvidenceLocatorSchema,
  Verification: evidence.VerificationSchema,
  RecordCitation: evidence.RecordCitationSchema,
  // eligibility
  EligibilityRule: eligibility.EligibilityRuleSchema,
  EligibilityRuleSet: eligibility.EligibilityRuleSetSchema,
  EligibilityRuleSetDraft: eligibility.EligibilityRuleSetDraftSchema,
  NominationProcess: eligibility.NominationProcessSchema,
  EligibilityResult: eligibility.EligibilityResultSchema,
  EligibilityCheckRequest: eligibility.EligibilityCheckRequestSchema,
  // student
  StudentProfile: student.StudentProfileSchema,
  TrackerItem: student.TrackerItemSchema,
  RequirementProgress: student.RequirementProgressSchema,
  ConsentRecord: student.ConsentRecordSchema,
  // readiness and roadmap
  ReadinessReport: readiness.ReadinessReportSchema,
  Roadmap: roadmap.RoadmapSchema,
  RoadmapItem: roadmap.RoadmapItemSchema,
  RoadmapTemplate: roadmap.RoadmapTemplateSchema,
  // events
  ChangeEvent: events.ChangeEventSchema,
  Alert: events.AlertSchema,
  Notification: events.NotificationSchema,
  // advisor and outcomes
  AdvisorWorkspace: advisor.AdvisorWorkspaceSchema,
  ProgramList: advisor.ProgramListSchema,
  OutcomeReport: advisor.OutcomeReportSchema,
  // ops
  Job: ops.JobSchema,
  JobLeaseRequest: ops.JobLeaseRequestSchema,
  JobLeaseResponse: ops.JobLeaseResponseSchema,
  AuditLogEntry: ops.AuditLogEntrySchema,
  ReviewTask: ops.ReviewTaskSchema,
  CreateReviewTaskInput: ops.CreateReviewTaskInputSchema,
  // AI
  AiSource: ai.AiSourceSchema,
  AiCitation: ai.AiCitationSchema,
  ReadinessExplainModelOutput: ai.ReadinessExplainModelOutputSchema,
  ReadinessExplainResponse: ai.ReadinessExplainResponseSchema,
  StatementFeedbackModelOutput: ai.StatementFeedbackModelOutputSchema,
  StatementFeedbackResponse: ai.StatementFeedbackResponseSchema,
  AskModelOutput: ai.AskModelOutputSchema,
  AskResponse: ai.AskResponseSchema,
  // pipeline
  ExtractionPageV1: extraction.ExtractionPageV1Schema,
  EligibilityRow: extraction.EligibilityRowSchema,
  CurationPatch: internal.CurationPatchSchema,
  CurationPatchResult: internal.CurationPatchResultSchema,
  SnapshotIngest: internal.SnapshotIngestSchema,
  ExtractionIngest: internal.ExtractionIngestSchema,
  Heartbeat: internal.HeartbeatSchema,
  // public API
  SearchRequest: api.SearchRequestSchema,
  AnalyticsEvent: api.AnalyticsEventSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type JsonSchemaExportName = keyof typeof JSON_SCHEMA_EXPORTS;

/** Model-output schemas are emitted in "output" mode: every field required. */
export const OUTPUT_MODE_EXPORTS: ReadonlySet<JsonSchemaExportName> = new Set<JsonSchemaExportName>([
  "ReadinessExplainModelOutput",
  "StatementFeedbackModelOutput",
  "AskModelOutput",
  "ExtractionPageV1",
  "EligibilityRow",
  "ReadinessReport",
  "EligibilityResult",
  "ProgramCard",
  "ProgramDetail",
  "ReleaseArtifact",
]);
