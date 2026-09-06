import { sha256 } from "../core/canonical.js";

/** One durable analysis receipt stream per inspected source keeps browser subscriptions narrow. */
export const inspectorAnalysisStream = (sourceStream: string): string =>
  `agents/inspector/by-source/${sha256(sourceStream.trim())}`;
