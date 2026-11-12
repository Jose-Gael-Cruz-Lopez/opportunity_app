/**
 * Outcome reporting in the client. Mount points (integration):
 * - OutcomePrompt: inside each Tracker card (client/src/pages/tracker/index.tsx, TrackerCard),
 *   below the "Move to" row, with the card's TrackerItem, ProgramCard and the viewer's today.
 * - OutcomeSummaryPanel: on the program page next to Part 3 (client/src/pages/program/index.tsx).
 * - BandStatusNote: optional, inside CompetitivenessPart, fed from the summary's `bands`.
 */
export { OutcomePrompt, OutcomeForm } from "./OutcomePrompt";
export type { OutcomePromptProps } from "./OutcomePrompt";
export { OutcomeSummaryPanel, OutcomeSummaryView, BandStatusNote, CycleSummary, BAND_STATUS_LABELS, suppressionText } from "./OutcomeSummaryPanel";
export { useMyOutcomes, useOutcomeSummary, useSaveOutcome, OUTCOME_KEYS } from "./api";
export * from "./model";
