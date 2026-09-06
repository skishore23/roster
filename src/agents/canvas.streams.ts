import { branchStream, runStream } from "../engine/runtime/workflow.js";

/** A durable stream for one visual-canvas run. */
export const canvasRunStream = runStream;

/** A task-local stream used by replay and provenance views. */
export const canvasBranchStream = branchStream;
