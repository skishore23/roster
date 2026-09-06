// ============================================================================
// Roster Replay constants
// ============================================================================

import type { InspectorMode } from "../modules/inspector.js";

export type InspectorTeamMember = {
  readonly id: string;
  readonly name: string;
  readonly mode: InspectorMode;
  readonly kind: "analyze" | "improve" | "timeline" | "qa";
};

export const INSPECTOR_TEAM: ReadonlyArray<InspectorTeamMember> = [
  { id: "analyst", name: "Analyst", mode: "analyze", kind: "analyze" },
  { id: "improver", name: "Improver", mode: "improve", kind: "improve" },
  { id: "chronologist", name: "Chronologist", mode: "timeline", kind: "timeline" },
  { id: "respondent", name: "Q&A", mode: "qa", kind: "qa" },
];
