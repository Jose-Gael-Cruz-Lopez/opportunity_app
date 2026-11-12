/**
 * The Curator API's request and response schemas moved to shared/contracts/curator.ts so the route
 * map (shared/contracts/routes.ts) can use them without importing server code. Re-exported here so
 * the router and its tests keep their imports.
 */
export * from "@shared/contracts/curator";
