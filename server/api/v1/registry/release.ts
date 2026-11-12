/**
 * Release file paths for API-side callers (curator rollback). The routes that serve
 * /data/release.json and /data/client-core/{n}.json live only in server/pages (index.tsx); this
 * module used to hold a second, unmounted copy of them, removed so one router serves /data/*.
 * It re-exports the pages module's key and path helpers so both sides name files the same way.
 */

import { RELEASE_POINTER_KEY, clientCoreKey, clientCorePath } from "@server/pages/release";

export { clientCorePath };

export const RELEASE_STORE_KEYS = {
  pointer: RELEASE_POINTER_KEY,
  clientCore: clientCoreKey,
} as const;
