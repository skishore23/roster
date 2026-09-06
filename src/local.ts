import { applyRosterLocalOnlyEnvironment } from "./runtime/local-only.js";

applyRosterLocalOnlyEnvironment();

await import("./server.js");
