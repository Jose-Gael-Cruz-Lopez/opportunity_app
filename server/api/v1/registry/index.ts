import { getDb } from "@server/db/client";
import { CardCache } from "./cards";
import type { RegistryDeps } from "./ports";
import { createRegistryRoutes } from "./routes";
import { createD1RegistryStore } from "./store";

/**
 * Public registry API. server/app.ts mounts `registryRoutes` at /api/v1. The release files
 * (/data/release.json and /data/client-core/{n}.json, on the route map's pages mount) are served
 * only by server/pages, including the live release 0 before the first build.
 */

export { createRegistryRoutes, PUBLIC_LIST_CACHE, PRIVATE_QUERY_CACHE, REGISTRY_CITATION, TAXONOMY_CACHE } from "./routes";
export { clientCorePath, RELEASE_STORE_KEYS } from "./release";
export { CardCache, type CardSet } from "./cards";
export { cardPlacement, placementAt, publicOrder } from "./order";
export { filterListCards, openToTwoYear, upcomingDeadlines } from "./listing";
export { createD1RegistryStore } from "./store";
export { OrganizationResponseSchema, TypeHubResponseSchema, type OrganizationResponse, type TypeHubResponse } from "./schemas";
export type { CitationOptions, InstitutionHit, OpportunityTypeCount, OrganizationRecord, RegistryDeps, RegistryStore } from "./ports";

/** One card set and search index per isolate, shared by every registry route. */
const sharedCards = new CardCache();

export const registryDeps: RegistryDeps = {
  store: (c) => createD1RegistryStore(getDb(c.env.DB)),
  now: () => Date.now(),
  origin: (c) => c.env.APP_ORIGIN,
  cards: sharedCards,
};

export const registryRoutes = createRegistryRoutes(registryDeps);
