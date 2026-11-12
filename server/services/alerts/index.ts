/**
 * server/services/alerts: ChangeEvent outbox -> Alerts. `fanOutChangeEvents` is the
 * `alerts.match` job; the pure copy rules are exported for the weekly composer and tests.
 */
export {
  alertableEvent,
  changeAlertDedupeKey,
  deadlineChangePriority,
  draftAlert,
  informationalKind,
  reachesRecipient,
  wantsOwnEmail,
  type AlertDraft,
  type AlertPriority,
  type ChangeEventInput,
  type CycleFacts,
} from "./copy";
export { fanOutChangeEvents, EVENTS_PER_TICK, RECIPIENT_CHUNK, type FanOutDeps } from "./fanout";
