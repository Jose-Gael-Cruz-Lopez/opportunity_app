/**
 * Public-page islands: small scripts that enhance server-rendered pages that are complete
 * without them. See README.md.
 */
export { RemindMeIsland, birthYears, type RemindMeIslandProps } from "./remind-me";
export { REMIND_JS, REMIND_CORE_JS, MIN_AGE_YEARS } from "./remind-me-js";
export { ISLANDS_CSS } from "./islands-css";
export { ISLAND_ASSET_PREFIX, REMIND_PAGE_CSP, createIslandAssetRoutes, islandAssetForPath, islandAssetPath, islandAssetRoutes, type IslandAssetName } from "./assets";
