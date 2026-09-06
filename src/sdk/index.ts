/**
 * Minimal package-root API.
 *
 * New integrations should import the narrow `roster/authoring`,
 * `roster/workspace`, `roster/orchestration`, `roster/capabilities`, or
 * `roster/runtime` entry point. The root intentionally contains only the
 * receipt-driven agent authoring surface.
 */
export * from "./authoring.js";
