/**
 * server/services/email: the EmailProvider (Cloudflare Email Sending binding, dry run locally),
 * the `notify.dispatch` job, RFC 8058 unsubscribe tokens and routes, and send-time policy.
 */
export { BREAKER_THRESHOLD, dispatchNotifications, queueEmailNotifications, sendDueEmail, unsubscribeListFor, type DispatchDeps } from "./dispatch";
export { isQuietTime, isUrgent, notificationExpiry, quotaAllows, sendClassFor, utcDayStart, DEFAULT_DAILY_QUOTA, QUOTA_HOLD_AT, type SendClass } from "./policy";
export {
  classifySendError,
  createCloudflareProvider,
  createDryRunProvider,
  providerFor,
  senderAddress,
  type EmailProvider,
  type EmailStream,
  type OutgoingEmail,
  type SendOutcome,
} from "./provider";
export { absoluteLink, escapeHtml, renderAlertEmail, safeSubject, type RenderedEmail } from "./templates";
export {
  emailLookupHmac,
  listUnsubscribeHeaders,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
  UNSUBSCRIBE_LISTS,
  UNSUBSCRIBE_TTL_MS,
  type UnsubscribeClaims,
  type UnsubscribeList,
} from "./tokens";
export { applyUnsubscribe, emailLinkRoutes, isOneClickBody } from "./unsubscribe";
