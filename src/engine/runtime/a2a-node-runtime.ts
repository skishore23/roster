import {
  isNodeExecutionResult,
  type NodeRuntimeAdapter,
} from "./node-runtime.js";
import type { WorkspaceNodeRuntimeKind } from "../orchestration/types.js";

export type A2AFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export type A2ANodeRuntimeOptions = {
  readonly kind?: WorkspaceNodeRuntimeKind;
  readonly fetch?: A2AFetch;
  readonly maxResponseBytes?: number;
};

const endpointUrl = (kind: string, endpoint: string | undefined): URL => {
  if (!endpoint?.trim()) throw new Error(`Node runtime ${kind} requires an endpoint`);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Node runtime ${kind} has an invalid endpoint`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Node runtime ${kind} endpoint must use HTTP or HTTPS`);
  }
  return url;
};

const readBoundedResponse = async (response: Response, kind: string, maxBytes: number): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Node runtime ${kind} response exceeded maxResponseBytes=${maxBytes}`);
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

/** Sends one execution envelope to an HTTP agent and validates its result. */
export const createA2ANodeRuntimeAdapter = (
  options: A2ANodeRuntimeOptions = {},
): NodeRuntimeAdapter => {
  const kind = options.kind ?? "a2a";
  const send = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = Math.max(1_024, options.maxResponseBytes ?? 1_048_576);
  return {
    kind,
    validateRuntime: (runtime) => { endpointUrl(kind, runtime.endpoint); },
    executeEnvelope: async (envelope, control) => {
      if (envelope.surface.codeMode) {
        throw new Error(`Node runtime ${kind} does not support code mode`);
      }
      const endpoint = endpointUrl(kind, envelope.runtime.endpoint);
      const response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(envelope),
        signal: control.signal,
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        throw new Error(`Node runtime ${kind} response exceeded maxResponseBytes=${maxResponseBytes}`);
      }
      const body = await readBoundedResponse(response, kind, maxResponseBytes);
      if (!response.ok) {
        throw new Error(`Node runtime ${kind} request failed with HTTP ${response.status}: ${body.trim() || "empty response"}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Node runtime ${kind} returned invalid JSON`);
      }
      if (!isNodeExecutionResult(parsed)) {
        throw new Error(`Node runtime ${kind} returned an invalid execution result`);
      }
      return parsed;
    },
  };
};
