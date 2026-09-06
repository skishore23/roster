import { esc } from "./agent-framework.js";

export type RosterRealtimeDomain = "theorem" | "axiom" | "writer" | "axiom-simple" | "replay";

export type RosterRealtimeBootConfig = {
  readonly domain: RosterRealtimeDomain;
  readonly stream: string;
  readonly runId?: string;
  readonly runStream?: string;
  readonly branchStream?: string;
  readonly workspaceId: string;
  /** Short-lived viewer bearer. The client removes the boot node after parsing. */
  readonly capabilitySecret?: string;
  readonly realtime: {
    readonly enabled: boolean;
    readonly uri: string;
    readonly database: string;
    readonly confirmedReads: boolean;
  };
};

const scriptJson = (value: unknown): string => JSON.stringify(value)
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

export const rosterRealtimeBootHtml = (
  config: RosterRealtimeBootConfig,
  options: { readonly nonce?: string; readonly assetPath?: string } = {},
): string => {
  const nonce = options.nonce ? ` nonce="${esc(options.nonce)}"` : "";
  return `<script id="roster-realtime-boot" type="application/json"${nonce}>${scriptJson(config)}</script>
  <script type="module" src="${esc(options.assetPath ?? "/assets/roster-client.js")}"${nonce}></script>`;
};

export const rosterRealtimeStatusHtml = (label = "Connecting to durable run state…"): string =>
  `<span class="agent-status" data-roster-connection data-tone="warning" role="status" aria-live="polite" aria-atomic="true">${esc(label)}</span>`;
