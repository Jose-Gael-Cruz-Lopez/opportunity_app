import { createInternalRoutes } from "./routes";

/**
 * server/internal: the `/internal/v1/*` router for the pipeline (HMAC, key scopes, nonce replay
 * protection and idempotent handlers). server/app.ts mounts `internalRoutes` at /internal/v1.
 */
export const internalRoutes = createInternalRoutes();

export { createInternalRoutes, type InternalRouteOptions } from "./routes";
export { internalAuth, MAX_JSON_BYTES, MAX_RAW_BYTES, type InternalAppEnv, type InternalVariables } from "./auth";
export { canonicalString, signCanonical, verifySignedRequest, readSignedHeaders, nonceExpiresAt, HMAC_SCHEME, MAX_SKEW_SECONDS, CONTENT_SHA_HEADER, IDEMPOTENCY_HEADER } from "./hmac";
export { INTERNAL_ROUTE_IDS, KEY_SCOPES, keyFamily, leasableKinds, mayCall, mayHandleKind, parseKeyring, scopeFor, type InternalRouteId, type KeyFamily } from "./keys";
export { checkUrlChain, hostOf, resolveSeedPolicy, HOST_POLICY_SEED } from "./host-policy";
