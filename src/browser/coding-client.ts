import {
  DbConnection,
  type SubscriptionHandle,
} from "../spacetimedb-bindings/index.js";
import { SenderError } from "spacetimedb";
import { initializeCodingBuildGuard, resolveCodingBuildStorage } from "./coding-build.js";
import {
  codingLiveActivityPresentation,
  codingNodePresentation,
  codingRunPresentation,
  isCodingUserVisibleTask,
  type CodingNodePresentationState,
  type CodingPublicFailureCategory,
  type CodingRunPresentation,
} from "./coding-presentation.js";
import { codingRuntimeTelemetry } from "./coding-progress-updates.js";
import {
  codingNodeExecutionIdentity,
  type CodingActiveRuntimeBinding,
} from "./coding-active-runtime.js";
import {
  restoredScrollTop,
  shouldOfferNewMessages,
} from "./coding-scroll-anchor.js";
import {
  projectCodingDurableTimelineRows,
  projectCodingSocialRows,
  reconcileCodingLiveSocialRows,
  type CodingSocialDurableTimelineInput,
  type CodingSocialParticipant,
  type CodingSocialTaskEdgeInput,
  type CodingSocialTaskInput,
  type CodingSocialUpsertRow,
} from "./coding-social-transcript.js";
import {
  BoundedCodingRoomUpdateBuffer,
  BoundedNdjsonLineDecoder,
  BoundedRuntimeLogBuffer,
  CodingRoomReconnectBackoff,
  acceptCurrentCodingStreamChunk,
  acceptCurrentCodingStreamResponse,
  awaitCurrentCodingStreamResponse,
  codingRoomReconnectDelay,
  codingRoomStreamEofTransition,
  codingViewerGrantIsFresh,
  createCodingViewerGrantRenewal,
  createIdempotentDisposer,
  routeCodingRoomStreamAdmission,
  parseCodingRoomUpdate,
  readCurrentCodingStreamChunk,
  shouldOpenCodingRoomStream,
  type CodingViewerGrantRenewal,
  type CodingRoomUpdateValidationContext,
} from "./coding-room-stream.js";
import type { NodeRoomUpdate } from "../engine/runtime/node-room-updates.js";

type TimestampLike = { readonly microsSinceUnixEpoch: bigint };

type CodingRealtimeBoot = {
  readonly workspaceId: string;
  readonly codingWorkspaceId: string;
  readonly roomId?: string;
  readonly activeRunId?: string;
  readonly conversationId?: string;
  readonly job?: {
    readonly id: string;
    readonly status: string;
    readonly runKind?: string;
  };
  /** Server-certified completion wins over an older final accounting receipt. */
  readonly committedUsageNote?: boolean;
  /** Git delivery is server-authoritative; execution receipts stop at certification. */
  readonly delivery?: {
    readonly status: "working" | "finalizing" | "ready" | "integrated" | "no-changes" | "kept-branch" | "blocked" | "unavailable";
    readonly certified: boolean;
    readonly branch?: string;
    readonly targetBranch?: string;
    readonly reason?: string;
  };
  readonly realtime: {
    readonly enabled: boolean;
    readonly uri: string;
    readonly database: string;
    readonly confirmedReads: boolean;
  };
};

type RoomRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomKey: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly activeRunId: string;
  readonly certifiedCheckpointId: string;
  readonly nextTimelineSeq: bigint;
  readonly createdAt: TimestampLike;
  readonly updatedAt: TimestampLike;
};

type TimelineRow = {
  readonly selectionRowId: string;
  readonly selectionId: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly runId: string;
  readonly seq: bigint;
  readonly kind: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly entryJson: string;
  readonly createdAt: TimestampLike;
};

type RoomNodeRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly capabilitiesJson: string;
  readonly parentNodeId: string;
  readonly createdAt: TimestampLike;
  readonly updatedAt: TimestampLike;
};

type ParticipantProfileRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly displayName: string;
  readonly role: string;
  readonly bio: string;
  readonly skillsJson: string;
  readonly capabilitiesJson: string;
  readonly revision: bigint;
  readonly createdAt: TimestampLike;
  readonly updatedAt: TimestampLike;
};

type ContextFrontierRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly runId: string;
  readonly contextVersion: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly bindingVersion: string;
  readonly createdAt: TimestampLike;
  readonly updatedAt: TimestampLike;
};

type ExecutionSummaryRow = {
  readonly workspaceId: string;
  readonly runId: string;
  readonly kind: string;
  readonly status: string;
  readonly graphVersion: bigint;
  readonly totalTasks: number;
  readonly readyTasks: number;
  readonly blockedTasks: number;
  readonly inflightTasks: number;
  readonly acceptedTasks: number;
  readonly failedTasks: number;
  readonly canceledTasks: number;
  readonly skippedTasks: number;
  readonly terminalReason: string;
  readonly updatedAt: TimestampLike;
};

type TaskRow = {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly status: string;
  readonly attempt: number;
  readonly failureCategory: CodingPublicFailureCategory | "";
  readonly failureReason: string;
  readonly updatedAt: TimestampLike;
};

type TaskEdgeRow = {
  readonly id: string;
  readonly runId: string;
  readonly taskKey: string;
  readonly prerequisiteTaskKey: string;
  readonly condition: string;
  readonly createdAt: TimestampLike;
};

type TaskOutputReferenceRow = {
  readonly id: string;
  readonly runId: string;
  readonly taskKey: string;
  readonly taskId: string;
  readonly outcomeId: string;
  readonly artifactId: string;
  readonly outputKey: string;
  readonly referenceJson: string;
  readonly createdAt: TimestampLike;
};

type CollaborationSummaryRow = {
  readonly runId: string;
  readonly workspaceId: string;
  readonly proposalCount: number;
  readonly responseCount: number;
  readonly endorsementCount: number;
  readonly updatedAt: TimestampLike;
};

type RuntimeBindingRow = CodingActiveRuntimeBinding & {
  readonly createdAt: TimestampLike;
};

type ControlIntentRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly intentId: string;
  readonly kind: string;
  readonly status: string;
  readonly targetRunId: string;
  readonly createdAt: TimestampLike;
};

type RuntimeLogRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly runtime: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly sequence: number;
  readonly at: number;
  readonly truncated: boolean;
};

type RowTable<Row> = {
  iter: () => Iterable<Row>;
  onInsert: (callback: (context: unknown, row: Row) => void) => void;
  onUpdate: (callback: (context: unknown, previous: Row, row: Row) => void) => void;
  onDelete: (callback: (context: unknown, row: Row) => void) => void;
};

type CodingDatabase = {
  readonly myCodingRoomsWindow: RowTable<RoomRow>;
  readonly myCodingRoomNodesWindow: RowTable<RoomNodeRow>;
  readonly myCodingParticipantProfilesWindow: RowTable<ParticipantProfileRow>;
  readonly myCodingRoomTimeline: RowTable<TimelineRow>;
  readonly myCodingRoomTimelinePage: RowTable<TimelineRow>;
  readonly myCodingRoomTimelineWindow: RowTable<TimelineRow>;
  readonly myCodingControlIntentDeliveriesWindow: RowTable<ControlIntentRow>;
  readonly myCodingContextFrontiersWindow: RowTable<ContextFrontierRow>;
  readonly myCodingExecutionSummariesWindow: RowTable<ExecutionSummaryRow>;
  readonly myCodingRunTasksWindow: RowTable<TaskRow>;
  readonly myCodingRunTaskEdgesWindow: RowTable<TaskEdgeRow>;
  readonly myCodingRunTaskOutputReferencesWindow: RowTable<TaskOutputReferenceRow>;
  readonly myCodingCollaborationSummariesWindow: RowTable<CollaborationSummaryRow>;
  readonly myCodingActiveRuntimeBindingsWindow: RowTable<RuntimeBindingRow>;
};

type TimelineEntry = Readonly<Record<string, unknown>> & {
  readonly kind?: string;
  readonly body?: string;
  readonly summary?: string;
  readonly decision?: string;
  readonly reason?: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly verdict?: string;
  readonly authorNodeId?: string;
  readonly outputKeys?: ReadonlyArray<string>;
};

type FocusSnapshot = {
  readonly active: HTMLElement | null;
  readonly focusKey?: string;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
};

type UiSnapshot = {
  readonly composerValue?: string;
  readonly messageCount: number;
  readonly focus: FocusSnapshot;
  readonly scroll: ReadonlyArray<{
    readonly element: HTMLElement;
    readonly top: number;
    readonly left: number;
    readonly followEnd: boolean;
    readonly anchor: HTMLElement | null;
    readonly anchorOffset?: number;
  }>;
  readonly disclosures: ReadonlyMap<string, boolean>;
  readonly selectedAgent?: string;
};

const BOOT_ID = "coding-realtime-boot";
const IDENTITY_TOKEN_KEY = "roster.coding.identity-token.v1";
const CURSOR_STORAGE_PREFIX = "roster.coding.timeline-cursor.v1";
const INITIAL_TIMELINE_WINDOW = 12;
const TIMELINE_PAGE_SIZE = 20;
const createCodingTimelineSelectionId = (): string => `browser-${crypto.randomUUID()}`;
// Per-document memory deliberately keeps same-identity tabs independent while
// preserving this tab's authority across transport reconnects.
const timelineSelectionId = createCodingTimelineSelectionId();

initializeCodingBuildGuard(document, resolveCodingBuildStorage(() => sessionStorage));

const bootNode = document.getElementById(BOOT_ID);
if (!bootNode?.textContent) throw new Error("Coding realtime boot configuration is missing");
const boot = JSON.parse(bootNode.textContent) as CodingRealtimeBoot;
bootNode.remove();
const roomUpdatesModelNode = document.getElementById("coding-room-updates-model");
const roomUpdatesModelText = roomUpdatesModelNode?.textContent ?? "";
roomUpdatesModelNode?.remove();

const roomId = boot.roomId
  ?? document.querySelector<HTMLElement>("[data-room-id]")?.dataset.roomId
  ?? "";
let activeRunId = boot.activeRunId ?? "";
let generation = 0;
let connection: DbConnection | undefined;
let subscription: SubscriptionHandle | undefined;
let timelineHistorySubscriptions: SubscriptionHandle[] = [];
const timelineHistoryRanges = new Set<string>();
let reconnectTimer = 0;
let reconnectNoticeTimer = 0;
let viewerGrantRenewal: CodingViewerGrantRenewal | undefined;
let reconnectAttempt = 0;
let disposed = false;
let applied = false;
let hasAppliedSubscription = false;
let visibleTimelineRows = INITIAL_TIMELINE_WINDOW;
let terminalDeliveryRefreshScheduled = false;
let runtimeLogController: AbortController | undefined;
let runtimeLogReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let runtimeLogReconnectTimer = 0;
let runtimeLogGeneration = 0;
let runtimeLogCursor = 0;
let runtimeLogState: "connecting" | "live" | "paused" = "connecting";
let runtimeLogLastSignalAt = 0;
let roomUpdateController: AbortController | undefined;
let roomUpdateReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let roomUpdateReconnectTimer = 0;
let roomUpdateGeneration = 0;
let roomUpdateRenderFrame = 0;
let roomUpdateState: "live" | "paused" = "paused";
let roomUpdateStreamIdentity = "";
let roomUpdateReconnectIdentity = "";
let renderedRoomUpdateRows: CodingSocialUpsertRow[] = [];
let renderFrame = 0;
let runtimeLogRenderFrame = 0;
let preflightReconcileTimer = 0;
let preflightReconcileAttempt = 0;

const rooms = new Map<string, RoomRow>();
const timeline = new Map<string, TimelineRow>();
const nodes = new Map<string, RoomNodeRow>();
const participantProfiles = new Map<string, ParticipantProfileRow>();
const frontiers = new Map<string, ContextFrontierRow>();
const executions = new Map<string, ExecutionSummaryRow>();
const tasks = new Map<string, TaskRow>();
const taskEdges = new Map<string, TaskEdgeRow>();
const outputReferences = new Map<string, TaskOutputReferenceRow>();
const collaborationSummaries = new Map<string, CollaborationSummaryRow>();
const bindings = new Map<string, RuntimeBindingRow>();
const intents = new Map<string, ControlIntentRow>();
const runtimeLogs = new BoundedRuntimeLogBuffer<RuntimeLogRow>();
const roomUpdates = new BoundedCodingRoomUpdateBuffer();
const roomUpdateReconnectBackoff = new CodingRoomReconnectBackoff();

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const parseJsonRecord = (value: string): Readonly<Record<string, unknown>> => {
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
};

const repositoryWorkspaceId = document.querySelector<HTMLInputElement>(
  '[data-coding-node-settings] input[name="workspaceId"], [data-coding-form] input[name="workspaceId"]',
)?.value.trim() ?? "";

type CodingWorkspacePreference = {
  readonly nodeId: string;
  readonly workerRuntime: "codex-cli" | "claude-code" | "pi-agent" | "hermes-agent";
  readonly codexModel: string;
  readonly piModel: string;
  readonly claudeModel: string;
  readonly hermesModel: string;
};

const workspacePreference = (nodeId: string): CodingWorkspacePreference | undefined => {
  const form = document.querySelector<HTMLFormElement>(
    `[data-coding-node-setting="${CSS.escape(nodeId)}"] [data-coding-node-settings]`,
  );
  const runtime = form?.elements.namedItem("workerRuntime");
  const codex = form?.elements.namedItem("codexModel");
  const pi = form?.elements.namedItem("piModel");
  const claude = form?.elements.namedItem("claudeModel");
  const hermes = form?.elements.namedItem("hermesModel");
  if (!(runtime instanceof HTMLSelectElement)
    || !(codex instanceof HTMLSelectElement)
    || !(pi instanceof HTMLSelectElement)
    || !(claude instanceof HTMLSelectElement)
    || !(hermes instanceof HTMLSelectElement)
    || !(["codex-cli", "claude-code", "pi-agent", "hermes-agent"] as ReadonlyArray<string>).includes(runtime.value)) return undefined;
  return {
    nodeId,
    workerRuntime: runtime.value as CodingWorkspacePreference["workerRuntime"],
    codexModel: codex.value,
    piModel: pi.value,
    claudeModel: claude.value,
    hermesModel: hermes.value,
  };
};

const displayModel = (model: string): string => model
  .replace(/^openai(?:-codex)?\//, "")
  .replace("gpt-5.6-sol", "GPT-5.6 Sol")
  .replace("gpt-5.6-terra", "GPT-5.6 Terra")
  .replace("gpt-5.6-luna", "GPT-5.6 Luna");

const preferenceIdentity = (preference: CodingWorkspacePreference): {
  readonly agent: string;
  readonly model: string;
} => {
  const selection = preference.workerRuntime === "pi-agent"
    ? { agent: "Pi Code", model: preference.piModel }
    : preference.workerRuntime === "claude-code"
      ? { agent: "Claude Code", model: preference.claudeModel }
      : preference.workerRuntime === "hermes-agent"
        ? { agent: "Hermes Agent", model: preference.hermesModel }
        : { agent: "Codex CLI", model: preference.codexModel };
  return { agent: selection.agent, model: displayModel(selection.model) };
};

const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const numberValue = (value: unknown): number => typeof value === "number" ? value : Number.NaN;

const resolutionReviewerNode = (node: RoomNodeRow): boolean =>
  node.nodeId.startsWith("coding.resolution.");

const nodePresentationName = (node: RoomNodeRow): string =>
  resolutionReviewerNode(node) ? "Resolution Reviewer" : node.name;

const normalizeResolutionReviewerLabels = (): void => {
  const legacy = "Temporary Resolution Peer";
  for (const element of document.querySelectorAll<HTMLElement>("button, strong, span")) {
    if (element.textContent?.trim() === legacy) element.textContent = "Resolution Reviewer";
  }
  for (const element of document.querySelectorAll<HTMLElement>("[aria-label], [title]")) {
    for (const attribute of ["aria-label", "title"] as const) {
      const value = element.getAttribute(attribute);
      if (value?.includes(legacy)) element.setAttribute(attribute, value.replaceAll(legacy, "Resolution Reviewer"));
    }
  }
};

const parseStringArray = (value: string | undefined): ReadonlyArray<string> => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const profileNodeIdForName = (name: string): string => {
  if (name.toLocaleLowerCase() === "you") return "human.operator";
  const profile = [...participantProfiles.values()].find((candidate) =>
    candidate.displayName.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (profile) return profile.nodeId;
  const node = [...nodes.values()].find((candidate) =>
    candidate.nodeId.toLocaleLowerCase() === name.toLocaleLowerCase()
    || candidate.name.split(",", 1)[0]?.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  return node?.nodeId ?? (name.toLocaleLowerCase() === "roster" ? "coordinator" : name);
};

const participantTrigger = (input: {
  readonly nodeId: string;
  readonly name: string;
  readonly role?: string;
  readonly kind?: string;
  readonly mention?: boolean;
  readonly agent?: string;
  readonly model?: string;
  readonly executionScope?: "message" | "active" | "preference";
}): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = input.mention
    ? "participant-mention"
    : "coding-message-author-link participant-profile-trigger";
  button.dataset.participantProfile = input.nodeId;
  button.dataset.profileName = input.name;
  button.dataset.profileRole = input.role ?? (input.nodeId === "human.operator" ? "Workspace participant" : "Agent");
  button.dataset.profileKind = input.kind ?? (input.nodeId === "human.operator" ? "human" : input.nodeId === "coordinator" ? "system" : "agent");
  button.dataset.profileBio = "";
  button.dataset.profileSkills = "[]";
  button.dataset.profileCapabilities = "[]";
  if (input.agent) button.dataset.profileAgent = input.agent;
  if (input.model) button.dataset.profileModel = input.model;
  if (input.executionScope) button.dataset.profileExecutionScope = input.executionScope;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "participant-profile-dialog");
  button.title = `Open ${input.name}’s profile`;
  button.textContent = input.mention ? `@${input.name}` : input.name;
  return button;
};

const renderMessageAddress = (
  address: HTMLElement,
  recipients: ReadonlyArray<string>,
): void => {
  address.replaceChildren();
  address.setAttribute("aria-label", "Sent to");
  if (recipients.length === 0) {
    address.hidden = true;
    return;
  }
  address.hidden = false;
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  address.append(arrow);
  for (const recipient of recipients) {
    address.append(participantTrigger({
      nodeId: profileNodeIdForName(recipient.replace(/^@/, "")),
      name: recipient.replace(/^@/, ""),
      mention: true,
    }));
  }
};

const updateParticipantProfileTriggers = (profile: ParticipantProfileRow): void => {
  for (const trigger of document.querySelectorAll<HTMLElement>(
    `[data-participant-profile="${CSS.escape(profile.nodeId)}"]`,
  )) {
    trigger.dataset.profileName = profile.displayName;
    trigger.dataset.profileRole = profile.role;
    trigger.dataset.profileBio = profile.bio;
    trigger.dataset.profileSkills = profile.skillsJson;
    trigger.dataset.profileCapabilities = profile.capabilitiesJson;
    if (trigger.classList.contains("participant-mention")) trigger.textContent = `@${profile.displayName}`;
    else if (trigger.classList.contains("coding-message-author-link")) trigger.textContent = profile.displayName;
    const member = trigger.closest<HTMLElement>("[data-room-member]");
    const identity = member?.querySelector<HTMLElement>(".room-roster-identity");
    const avatar = member?.querySelector<HTMLElement>(".room-roster-avatar");
    if (identity) {
      const name = identity.querySelector<HTMLElement>("strong");
      const meta = identity.querySelector<HTMLElement>("small");
      if (name) name.textContent = profile.displayName;
      if (meta) meta.textContent = `@${profile.displayName.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-")} · ${profile.role}`;
    }
    if (avatar) avatar.textContent = (profile.displayName[0] || "?").toUpperCase();
  }
};

const updateParticipantExecutionTriggers = (): void => {
  for (const trigger of document.querySelectorAll<HTMLElement>("[data-participant-profile]")) {
    if (trigger.dataset.profileExecutionScope === "message") continue;
    const nodeId = trigger.dataset.participantProfile;
    if (!nodeId || nodeId === "human.operator" || nodeId === "coordinator") continue;
    const node = [...nodes.values()].find((candidate) => candidate.nodeId === nodeId);
    const binding = latestBindingFor(nodeId);
    const activeIdentity = node && binding ? nodeRuntimeIdentity(node, binding) : undefined;
    const preference = workspacePreference(nodeId);
    const identity = activeIdentity
      ? { agent: activeIdentity.runtime, model: activeIdentity.model, scope: "active" as const }
      : preference
        ? { ...preferenceIdentity(preference), scope: "preference" as const }
        : undefined;
    if (!identity) continue;
    trigger.dataset.profileAgent = identity.agent;
    trigger.dataset.profileModel = identity.model;
    trigger.dataset.profileExecutionScope = identity.scope;
    if (trigger.classList.contains("coding-message-execution")) {
      trigger.hidden = false;
      trigger.textContent = `${identity.agent} · ${identity.model}`;
    }
  }
  for (const row of document.querySelectorAll<HTMLElement>("[data-coding-agent-node]")) {
    const nodeId = row.dataset.codingAgentNode;
    if (!nodeId) continue;
    const preference = workspacePreference(nodeId);
    if (!preference) continue;
    const identity = preferenceIdentity(preference);
    const execution = row.querySelector<HTMLElement>(".coding-project-agent-execution");
    if (execution) {
      execution.dataset.codingAgent = identity.agent;
      execution.dataset.codingModel = identity.model;
      execution.replaceChildren();
      for (const [label, value] of [["Agent", identity.agent], ["Model", identity.model]]) {
        const field = document.createElement("span");
        const term = document.createElement("b");
        term.textContent = label;
        field.append(term, ` ${value}`);
        execution.append(field);
      }
    }
    const settingsForm = document.querySelector<HTMLFormElement>(
      `[data-coding-node-setting="${CSS.escape(nodeId)}"] [data-coding-node-settings]`,
    );
    for (const [name, value] of [["workerRuntime", preference.workerRuntime], ["codexModel", preference.codexModel], ["piModel", preference.piModel], ["claudeModel", preference.claudeModel], ["hermesModel", preference.hermesModel]]) {
      const field = settingsForm?.elements.namedItem(name);
      if (field instanceof HTMLSelectElement) field.value = value;
    }
  }
};

const participantProfileDialog = document.querySelector<HTMLDialogElement>("[data-participant-profile-dialog]");
const participantProfileForm = participantProfileDialog?.querySelector<HTMLFormElement>("[data-participant-profile-form]");
let participantProfileReturnFocus: HTMLElement | null = null;
let participantProfileFormDirty = false;

const profileField = <ElementType extends HTMLInputElement | HTMLTextAreaElement>(
  name: string,
): ElementType | null => participantProfileForm?.elements.namedItem(name) as ElementType | null;

const renderProfileList = (selector: string, values: ReadonlyArray<string>): void => {
  const list = participantProfileDialog?.querySelector<HTMLElement>(selector);
  if (!list) return;
  list.replaceChildren();
  for (const value of values.length ? values : ["None added yet"]) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
};

const participantRuntimeEditor = participantProfileDialog?.querySelector<HTMLDetailsElement>("[data-participant-runtime-editor]");
const participantRuntimeForm = participantProfileDialog?.querySelector<HTMLFormElement>("[data-participant-runtime-form]");

const runtimeField = <ElementType extends HTMLInputElement | HTMLSelectElement>(
  name: string,
): ElementType | null => participantRuntimeForm?.elements.namedItem(name) as ElementType | null;

const syncRuntimeModelFields = (): void => {
  const runtime = runtimeField<HTMLSelectElement>("workerRuntime")?.value;
  for (const field of participantRuntimeForm?.querySelectorAll<HTMLElement>("[data-participant-model-field]") ?? []) {
    field.hidden = field.dataset.participantModelField !== runtime;
  }
};

const renderProfileExecution = (input: {
  readonly agent?: string;
  readonly model?: string;
  readonly scope?: "message" | "active" | "preference";
}): void => {
  const section = participantProfileDialog?.querySelector<HTMLElement>("[data-participant-profile-execution]");
  if (!section) return;
  section.hidden = !input.agent && !input.model;
  const agent = section.querySelector<HTMLElement>("[data-participant-profile-agent]");
  const model = section.querySelector<HTMLElement>("[data-participant-profile-model]");
  const scope = section.querySelector<HTMLElement>("[data-participant-profile-execution-scope]");
  if (agent) agent.textContent = input.agent || "Not recorded";
  if (model) model.textContent = input.model || "Not recorded";
  if (scope) scope.textContent = input.scope === "message"
    ? "This message"
    : input.scope === "active"
      ? "Active run"
      : "Future work";
};

type ProfileContinuity = {
  readonly status: "dormant" | "queued" | "working" | "waiting" | "suspended";
  readonly pendingItemCount: number;
  readonly pendingLaneCount: number;
  readonly activeCommitmentCount: number;
  readonly activeRoomLabel?: string;
  readonly memoryUpdatedAt?: number;
  readonly lanes: ReadonlyArray<{
    readonly roomLabel: string;
    readonly pendingItemCount: number;
    readonly active: boolean;
  }>;
};

const profileContinuity = (value: string | undefined): ProfileContinuity | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ProfileContinuity>;
    const statuses = new Set<ProfileContinuity["status"]>(["dormant", "queued", "working", "waiting", "suspended"]);
    if (
      !parsed.status
      || !statuses.has(parsed.status)
      || !Number.isFinite(parsed.pendingItemCount)
      || !Number.isFinite(parsed.pendingLaneCount)
      || !Number.isFinite(parsed.activeCommitmentCount)
    ) return undefined;
    const lanes = Array.isArray(parsed.lanes)
      ? parsed.lanes.filter((lane): lane is ProfileContinuity["lanes"][number] =>
          lane !== null
          && typeof lane === "object"
          && typeof lane.roomLabel === "string"
          && Number.isFinite(lane.pendingItemCount)
          && typeof lane.active === "boolean")
      : [];
    return {
      status: parsed.status,
      pendingItemCount: parsed.pendingItemCount!,
      pendingLaneCount: parsed.pendingLaneCount!,
      activeCommitmentCount: parsed.activeCommitmentCount!,
      ...(typeof parsed.activeRoomLabel === "string" ? { activeRoomLabel: parsed.activeRoomLabel } : {}),
      ...(Number.isFinite(parsed.memoryUpdatedAt) ? { memoryUpdatedAt: parsed.memoryUpdatedAt } : {}),
      lanes,
    };
  } catch {
    return undefined;
  }
};

const renderProfileContinuity = (continuity: ProfileContinuity | undefined): void => {
  const section = participantProfileDialog?.querySelector<HTMLElement>("[data-participant-profile-continuity]");
  if (!section) return;
  section.hidden = !continuity;
  if (!continuity) return;
  section.dataset.state = continuity.status;
  const set = (selector: string, value: string): void => {
    const target = section.querySelector<HTMLElement>(selector);
    if (target) target.textContent = value;
  };
  set("[data-participant-profile-continuity-status]", continuity.status === "working"
    ? "Working now"
    : continuity.status === "queued"
      ? "Starting"
      : continuity.status === "waiting"
        ? "Queued"
        : continuity.status === "suspended"
          ? "Paused"
          : "Available");
  set("[data-participant-profile-active-room]", continuity.activeRoomLabel || "No active room");
  set(
    "[data-participant-profile-inbox-count]",
    `${continuity.pendingItemCount} item${continuity.pendingItemCount === 1 ? "" : "s"} across ${continuity.pendingLaneCount} room${continuity.pendingLaneCount === 1 ? "" : "s"}`,
  );
  set("[data-participant-profile-commitment-count]", `${continuity.activeCommitmentCount} open`);
  set(
    "[data-participant-profile-memory-state]",
    continuity.memoryUpdatedAt === undefined
      ? "Not saved yet"
      : `Updated ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(continuity.memoryUpdatedAt))}`,
  );
  const laneWrap = section.querySelector<HTMLElement>("[data-participant-profile-lanes]");
  const laneList = section.querySelector<HTMLOListElement>("[data-participant-profile-lane-list]");
  if (laneWrap) laneWrap.hidden = continuity.lanes.length === 0;
  if (!laneList) return;
  laneList.replaceChildren();
  for (const lane of continuity.lanes.slice(0, 6)) {
    const item = document.createElement("li");
    item.dataset.state = lane.active ? "active" : "waiting";
    const label = document.createElement("span");
    label.textContent = lane.roomLabel || "Room";
    label.title = label.textContent;
    const count = document.createElement("small");
    count.textContent = lane.active ? "Working now" : `${lane.pendingItemCount} waiting`;
    item.append(label, count);
    laneList.append(item);
  }
};

const syncRuntimeEditor = (nodeId: string): void => {
  if (!participantRuntimeEditor || !participantRuntimeForm) return;
  const preference = workspacePreference(nodeId);
  participantRuntimeEditor.hidden = !preference;
  if (!preference) {
    participantRuntimeEditor.open = false;
    return;
  }
  const nodeField = runtimeField<HTMLInputElement>("nodeId");
  const workspaceField = runtimeField<HTMLInputElement>("workspaceId");
  const runtime = runtimeField<HTMLSelectElement>("workerRuntime");
  const codexModel = runtimeField<HTMLSelectElement>("codexModel");
  const piModel = runtimeField<HTMLSelectElement>("piModel");
  const claudeModel = runtimeField<HTMLSelectElement>("claudeModel");
  const hermesModel = runtimeField<HTMLSelectElement>("hermesModel");
  if (nodeField) nodeField.value = nodeId;
  if (workspaceField) workspaceField.value = repositoryWorkspaceId;
  if (runtime) runtime.value = preference.workerRuntime;
  if (codexModel) codexModel.value = preference.codexModel;
  if (piModel) piModel.value = preference.piModel;
  if (claudeModel) claudeModel.value = preference.claudeModel;
  if (hermesModel) hermesModel.value = preference.hermesModel;
  syncRuntimeModelFields();
};

const syncParticipantProfileDialog = (nodeId: string, trigger?: HTMLElement, force = false): void => {
  if (!participantProfileDialog || !participantProfileForm) return;
  if (participantProfileFormDirty && !force) return;
  const stored = [...participantProfiles.values()].find((profile) => profile.nodeId === nodeId);
  const node = [...nodes.values()].find((candidate) => candidate.nodeId === nodeId);
  const fallbackName = trigger?.dataset.profileName || node?.name.split(",", 1)[0]?.trim() || nodeId;
  const fallbackRole = trigger?.dataset.profileRole || (node ? nodeRole(node) : "Workspace participant");
  const fallbackBio = trigger?.dataset.profileBio || "";
  const fallbackSkills = parseStringArray(trigger?.dataset.profileSkills);
  const fallbackCapabilities = parseStringArray(trigger?.dataset.profileCapabilities);
  let nodeCapabilities: ReadonlyArray<string> = [];
  try {
    const parsed = JSON.parse(node?.capabilitiesJson ?? "[]") as unknown;
    nodeCapabilities = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    nodeCapabilities = [];
  }
  const displayName = stored?.displayName ?? fallbackName;
  const role = stored?.role ?? fallbackRole;
  const bio = stored?.bio ?? fallbackBio;
  const skills = stored ? parseStringArray(stored.skillsJson) : fallbackSkills;
  const capabilities = stored ? parseStringArray(stored.capabilitiesJson) : (fallbackCapabilities.length ? fallbackCapabilities : nodeCapabilities);
  const triggerScope = trigger?.dataset.profileExecutionScope;
  const boundIdentity = node ? nodeRuntimeIdentity(node, latestBindingFor(nodeId)) : undefined;
  const preference = workspacePreference(nodeId);
  const preferredIdentity = preference ? preferenceIdentity(preference) : undefined;
  const executionScope: "message" | "active" | "preference" = triggerScope === "message" || triggerScope === "active"
    ? triggerScope
    : "preference" as const;
  const execution = trigger?.dataset.profileAgent || trigger?.dataset.profileModel
    ? {
        agent: trigger.dataset.profileAgent,
        model: trigger.dataset.profileModel,
        scope: executionScope,
      }
    : boundIdentity && boundIdentity.runtime !== "Agent binding pending"
      ? { agent: boundIdentity.runtime, model: boundIdentity.model, scope: "active" as const }
      : preferredIdentity
        ? { ...preferredIdentity, scope: "preference" as const }
        : {};
  participantProfileDialog.dataset.activeNodeId = nodeId;
  const title = participantProfileDialog.querySelector<HTMLElement>("[data-participant-profile-title]");
  const roleText = participantProfileDialog.querySelector<HTMLElement>("[data-participant-profile-role]");
  const bioText = participantProfileDialog.querySelector<HTMLElement>("[data-participant-profile-bio]");
  const kindText = participantProfileDialog.querySelector<HTMLElement>("[data-participant-profile-kind]");
  const avatar = participantProfileDialog.querySelector<HTMLElement>("[data-participant-profile-avatar]");
  if (title) title.textContent = displayName;
  if (roleText) roleText.textContent = role;
  if (bioText) bioText.textContent = bio || "No bio yet.";
  if (kindText) kindText.textContent = `${trigger?.dataset.profileKind || (nodeId === "coordinator" ? "system" : nodeId === "human.operator" ? "human" : "agent")} profile`;
  if (avatar) avatar.textContent = (displayName[0] || "?").toUpperCase();
  renderProfileList("[data-participant-profile-skills]", skills);
  renderProfileList("[data-participant-profile-capabilities]", capabilities);
  renderProfileExecution(execution);
  const continuityTrigger = trigger?.dataset.profileContinuity
    ? trigger
    : document.querySelector<HTMLElement>(
        `[data-participant-profile="${CSS.escape(nodeId)}"][data-profile-continuity]`,
      );
  renderProfileContinuity(profileContinuity(continuityTrigger?.dataset.profileContinuity));
  syncRuntimeEditor(nodeId);
  const nodeIdField = profileField<HTMLInputElement>("nodeId");
  const revisionField = profileField<HTMLInputElement>("revision");
  const nameField = profileField<HTMLInputElement>("displayName");
  const roleField = profileField<HTMLInputElement>("role");
  const bioField = profileField<HTMLTextAreaElement>("bio");
  const skillsField = profileField<HTMLInputElement>("skills");
  const capabilitiesField = profileField<HTMLInputElement>("capabilities");
  if (nodeIdField) nodeIdField.value = nodeId;
  if (revisionField) revisionField.value = String(stored?.revision ?? 0n);
  if (nameField) nameField.value = displayName;
  if (roleField) roleField.value = role;
  if (bioField) bioField.value = bio;
  if (skillsField) skillsField.value = skills.join(", ");
  if (capabilitiesField) capabilitiesField.value = capabilities.join(", ");
  participantProfileFormDirty = false;
};

const openParticipantProfile = (trigger: HTMLElement): void => {
  if (!participantProfileDialog) return;
  const nodeId = trigger.dataset.participantProfile;
  if (!nodeId) return;
  participantProfileReturnFocus = trigger;
  syncParticipantProfileDialog(nodeId, trigger, true);
  if (!participantProfileDialog.open) participantProfileDialog.showModal();
  participantProfileDialog.querySelector<HTMLElement>("[data-participant-profile-title]")?.focus();
};

participantProfileDialog?.addEventListener("click", (event) => {
  if (event.target === participantProfileDialog) participantProfileDialog.close();
});
participantProfileDialog?.addEventListener("close", () => {
  participantProfileFormDirty = false;
  participantProfileReturnFocus?.focus({ preventScroll: true });
  participantProfileReturnFocus = null;
});
participantProfileForm?.addEventListener("input", () => {
  participantProfileFormDirty = true;
});
participantProfileForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const status = participantProfileForm.querySelector<HTMLElement>("[data-participant-profile-status]");
  const submit = participantProfileForm.querySelector<HTMLButtonElement>("button[type='submit']");
  const split = (value: string): ReadonlyArray<string> => [...new Map(value.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => [item.toLocaleLowerCase(), item])).values()];
  const nodeId = profileField<HTMLInputElement>("nodeId")?.value.trim() ?? "";
  const displayName = profileField<HTMLInputElement>("displayName")?.value.trim() ?? "";
  const role = profileField<HTMLInputElement>("role")?.value.trim() ?? "";
  const bio = profileField<HTMLTextAreaElement>("bio")?.value.trim() ?? "";
  const skills = split(profileField<HTMLInputElement>("skills")?.value ?? "");
  const capabilities = split(profileField<HTMLInputElement>("capabilities")?.value ?? "");
  const expectedRevision = BigInt(profileField<HTMLInputElement>("revision")?.value || "0");
  if (!connection || !applied) {
    if (status) {
      status.dataset.state = "error";
      status.textContent = "Live profiles are still connecting.";
    }
    return;
  }
  if (submit) submit.disabled = true;
  if (status) {
    status.dataset.state = "saving";
    status.textContent = "Saving…";
  }
  void connection.reducers.saveRosterParticipantProfile({
    workspaceId: boot.workspaceId,
    nodeId,
    displayName,
    role,
    bio,
    skillsJson: JSON.stringify(skills),
    capabilitiesJson: JSON.stringify(capabilities),
    expectedRevision,
  }).then(() => {
    participantProfileFormDirty = false;
    syncParticipantProfileDialog(nodeId);
    if (status) {
      status.dataset.state = "success";
      status.textContent = "Saved live. Future runs use this profile.";
    }
  }).catch((error: unknown) => {
    if (status) {
      status.dataset.state = "error";
      status.textContent = error instanceof Error ? error.message : "Could not save this profile.";
    }
  }).finally(() => {
    if (submit) submit.disabled = false;
  });
});

participantRuntimeForm?.addEventListener("change", (event) => {
  if (event.target === runtimeField<HTMLSelectElement>("workerRuntime")) syncRuntimeModelFields();
});

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const sha256Hex = async (value: string): Promise<string> => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

type CodingViewerGrant = {
  readonly capabilitySecret: string;
  readonly expiresAt: number;
  /** Earlier revocable HTTP page authority used to mint the next grant. */
  readonly renewalExpiresAt: number;
};

let cachedCodingViewerGrant: CodingViewerGrant | undefined;
let codingViewerCapabilityPromise: Promise<CodingViewerGrant> | undefined;
const codingViewerCapability = (): Promise<CodingViewerGrant> => {
  if (cachedCodingViewerGrant
    && codingViewerGrantIsFresh(
      Math.min(cachedCodingViewerGrant.expiresAt, cachedCodingViewerGrant.renewalExpiresAt),
      Date.now(),
    )) {
    return Promise.resolve(cachedCodingViewerGrant);
  }
  codingViewerCapabilityPromise ??= fetch("/coding/realtime-session", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      workspaceId: boot.codingWorkspaceId,
      conversationId: boot.conversationId,
      jobId: boot.job?.id,
      executionId: boot.activeRunId,
    }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Coding realtime session failed with ${response.status}`);
    const payload = record(await response.json());
    const secret = stringValue(payload?.capabilitySecret);
    const expiresAt = numberValue(payload?.expiresAt);
    const pageSessionExpiresAt = numberValue(payload?.pageSessionExpiresAt);
    if (!secret || payload?.workspaceId !== boot.codingWorkspaceId
      || payload?.controlWorkspaceId !== boot.workspaceId
      || !codingViewerGrantIsFresh(expiresAt, Date.now(), 0)
      || !codingViewerGrantIsFresh(pageSessionExpiresAt, Date.now(), 0)) {
      throw new Error("Coding realtime session returned an invalid capability");
    }
    cachedCodingViewerGrant = {
      capabilitySecret: secret,
      expiresAt,
      renewalExpiresAt: pageSessionExpiresAt,
    };
    return cachedCodingViewerGrant;
  }).catch((error) => {
    throw error;
  }).finally(() => {
    codingViewerCapabilityPromise = undefined;
  });
  return codingViewerCapabilityPromise;
};

const identityToken = (): string | undefined => {
  try {
    return localStorage.getItem(IDENTITY_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const saveIdentityToken = (token: string): void => {
  try {
    localStorage.setItem(IDENTITY_TOKEN_KEY, token);
  } catch {
    // Private browsing may disable persistence; the live connection still works.
  }
};

const setLiveState = (
  state: "disabled" | "connecting" | "syncing" | "live" | "paused" | "reconnecting" | "error",
  label: string,
  detail: string,
): void => {
  const status = document.querySelector<HTMLElement>("[data-coding-live-status]");
  if (status) {
    status.dataset.state = state;
    status.textContent = label;
    status.title = detail;
  }
  const runPanel = document.querySelector<HTMLElement>("[data-coding-run-panel]");
  if (runPanel) runPanel.setAttribute("aria-busy", state === "syncing" || state === "connecting" ? "true" : "false");
  const progress = document.querySelector<HTMLElement>("[data-coding-run-progress]");
  if (progress) {
    progress.dataset.connection = state === "live"
      ? "live"
      : state === "paused" || state === "reconnecting" || state === "error" || state === "disabled"
        ? "stale"
        : "syncing";
    progress.dataset.connectionLabel = label;
  }
};

const takeUiSnapshot = (): UiSnapshot => {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selectable = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : undefined;
  const focusKey = active?.dataset.focusKey
    ?? active?.closest<HTMLElement>("[data-focus-key]")?.dataset.focusKey;
  const composer = document.querySelector<HTMLTextAreaElement>("[data-coding-form] textarea");
  const scroll = [...document.querySelectorAll<HTMLElement>(
    ".coding-conversation-scroll, [data-slot='context-cast'], [data-slot='timeline-list'], [data-coding-island='coordination-dock']",
  )].map((element) => {
    const conversation = element.matches(".coding-conversation-scroll");
    const followEnd = conversation
      && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
    const viewportTop = element.getBoundingClientRect().top;
    const anchor = conversation && !followEnd
      ? [...element.querySelectorAll<HTMLElement>("#coding-conversation-feed > li")]
        .find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1) ?? null
      : null;
    return {
      element,
      top: element.scrollTop,
      left: element.scrollLeft,
      followEnd,
      anchor,
      ...(anchor ? { anchorOffset: anchor.getBoundingClientRect().top - viewportTop } : {}),
    };
  });
  const disclosures = new Map<string, boolean>();
  for (const detail of document.querySelectorAll<HTMLDetailsElement>("details[data-details-key], details[data-disclosure-key]")) {
    const key = detail.dataset.detailsKey ?? detail.dataset.disclosureKey;
    if (key) disclosures.set(key, detail.open);
  }
  return {
    composerValue: composer?.value,
    messageCount: document.querySelectorAll("#coding-conversation-feed > li").length,
    focus: {
      active,
      focusKey,
      selectionStart: selectable?.selectionStart,
      selectionEnd: selectable?.selectionEnd,
    },
    scroll,
    disclosures,
    selectedAgent: document.querySelector<HTMLElement>("[data-selected-agent]")?.dataset.selectedAgent,
  };
};

const restoreUiSnapshot = (snapshot: UiSnapshot): void => {
  const composer = document.querySelector<HTMLTextAreaElement>("[data-coding-form] textarea");
  if (composer && snapshot.composerValue !== undefined && composer.value !== snapshot.composerValue) {
    composer.value = snapshot.composerValue;
  }
  for (const detail of document.querySelectorAll<HTMLDetailsElement>("details[data-details-key], details[data-disclosure-key]")) {
    const key = detail.dataset.detailsKey ?? detail.dataset.disclosureKey;
    const open = key ? snapshot.disclosures.get(key) : undefined;
    if (open !== undefined) detail.open = open;
  }
  for (const saved of snapshot.scroll) {
    if (saved.element.isConnected) {
      const anchorOffsetAfter = saved.anchor?.isConnected
        ? saved.anchor.getBoundingClientRect().top - saved.element.getBoundingClientRect().top
        : undefined;
      saved.element.scrollTop = restoredScrollTop({
        savedTop: saved.top,
        scrollHeight: saved.element.scrollHeight,
        followEnd: saved.followEnd,
        anchorOffsetBefore: saved.anchorOffset,
        anchorOffsetAfter,
      });
      saved.element.scrollLeft = saved.left;
    }
  }
  const conversationScroll = snapshot.scroll.find((saved) => saved.element.matches(".coding-conversation-scroll"));
  const newMessages = document.querySelector<HTMLButtonElement>("[data-coding-new-messages]");
  const currentMessageCount = document.querySelectorAll("#coding-conversation-feed > li").length;
  if (newMessages && conversationScroll) {
    if (shouldOfferNewMessages({
      followEnd: conversationScroll.followEnd,
      previousMessageCount: snapshot.messageCount,
      currentMessageCount,
    })) {
      const count = currentMessageCount - snapshot.messageCount;
      newMessages.dataset.count = String(count);
      const label = newMessages.querySelector<HTMLElement>("span:last-child");
      if (label) label.textContent = count === 1 ? "New message" : `${count} new messages`;
      newMessages.hidden = false;
    } else if (conversationScroll.followEnd) {
      newMessages.hidden = true;
      delete newMessages.dataset.count;
    }
  }
  const selectedAgent = snapshot.selectedAgent
    ? document.querySelector<HTMLElement>(`[data-selected-agent="${CSS.escape(snapshot.selectedAgent)}"]`)
    : undefined;
  const focusTarget = snapshot.focus.active?.isConnected
    ? snapshot.focus.active
    : snapshot.focus.focusKey
      ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(snapshot.focus.focusKey)}"]`)
      : selectedAgent;
  if (focusTarget && document.hasFocus()) {
    focusTarget.focus({ preventScroll: true });
    if (
      (focusTarget instanceof HTMLTextAreaElement || focusTarget instanceof HTMLInputElement)
      && snapshot.focus.selectionStart !== undefined
      && snapshot.focus.selectionStart !== null
    ) {
      focusTarget.setSelectionRange(
        snapshot.focus.selectionStart,
        snapshot.focus.selectionEnd ?? snapshot.focus.selectionStart,
      );
    }
  }
};

const replaceText = (selector: string, value: string): void => {
  const node = document.querySelector<HTMLElement>(selector);
  if (node && node.textContent !== value) node.textContent = value;
};

const replaceAllText = (selector: string, value: string): void => {
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (node.textContent !== value) node.textContent = value;
  }
};

const castName = (nodeId: string): string =>
  ([...nodes.values()].find((node) => node.nodeId === nodeId)?.name ?? nodeId) || "Roster";

const conversationalLabel = (value: unknown, fallback: string): string => {
  const label = stringValue(value)
    .replaceAll(/[._:/-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
  return label || fallback;
};

const taskActivityLabel = (taskId: string, completed = false): string => {
  const normalized = taskId.toLowerCase();
  if (normalized.includes("propos")) return completed ? "the design direction" : "shaping the design direction";
  if (normalized.includes("implement")) return completed ? "the implementation" : "implementing the agreed direction";
  if (normalized.includes("review")) return completed ? "the review" : "reviewing the implementation";
  if (normalized.includes("certif")) return completed ? "the final checks" : "running the final checks";
  if (normalized.includes("remediat")) return completed ? "the fixes" : "addressing review feedback";
  if (normalized.includes("validat")) return completed ? "validation" : "running validation";
  return conversationalLabel(taskId, completed ? "the previous step" : "the next step").toLowerCase();
};

const timelineCopy = (row: TimelineRow, entry: TimelineEntry): {
  readonly title: string;
  readonly body: string;
  readonly metadata: string;
} => {
  switch (row.kind) {
    case "message":
      return {
        title: castName(stringValue(entry.authorNodeId) || row.nodeId),
        body: stringValue(entry.body) || "Shared a message.",
        metadata: "Message",
      };
    case "claim":
      return {
        title: castName(row.nodeId),
        body: `Started ${taskActivityLabel(row.taskId)}.`,
        metadata: "Working",
      };
    case "artifact":
      return {
        title: castName(row.nodeId),
        body: `Shared ${conversationalLabel(entry.artifactKind, "a contribution")} with the team.`,
        metadata: "Shared",
      };
    case "decision":
      return {
        title: "Decision",
        body: stringValue(entry.decision) || "A durable decision was recorded.",
        metadata: stringValue(entry.subjectId),
      };
    case "handoff":
      return {
        title: "Handoff",
        body: `${taskActivityLabel(stringValue(entry.fromTaskId), true)} is ready for ${taskActivityLabel(stringValue(entry.toTaskId) || row.taskId)}.`,
        metadata: "Ready to continue",
      };
    case "review":
      return {
        title: castName(row.nodeId),
        body: stringValue(entry.summary) || `Reviewed ${stringValue(entry.reviewedTaskId) || row.taskId}.`,
        metadata: stringValue(entry.verdict).replaceAll("_", " ") || "Review",
      };
    case "checkpoint":
      return {
        title: "Certified checkpoint",
        body: "Saved a certified repository checkpoint.",
        metadata: "Saved",
      };
    case "attention":
      return {
        title: "Attention required",
        body: stringValue(entry.reason) || "The room needs an authorized decision.",
        metadata: stringValue(entry.severity) || "Attention",
      };
    default:
      return { title: row.kind || "Timeline update", body: "A durable room update was recorded.", metadata: "" };
  }
};

const renderTimeline = (): void => {
  const list = document.querySelector<HTMLOListElement>("[data-realtime-timeline]");
  if (!list) return;
  const activity = list.closest<HTMLDetailsElement>("[data-coding-island='team-activity']");
  const roomRows = [...timeline.values()]
    .filter((row) => row.roomId === roomId && (!activeRunId || !row.runId || row.runId === activeRunId))
    .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id));
  const selectedRows = roomRows
    // Authored conversation messages already render in the chat feed. The
    // Room OS timeline is a separate, optional activity log and must never
    // replace or duplicate that conversation.
    .filter((row) => row.kind !== "message");
  if (selectedRows.length === 0) {
    list.replaceChildren();
    if (activity) activity.hidden = true;
    return;
  }
  if (activity) activity.hidden = false;
  replaceText(
    "[data-coding-activity-summary]",
    `${selectedRows.length} live task update${selectedRows.length === 1 ? "" : "s"} · details stay out of chat`,
  );
  replaceText("[data-coding-activity-count]", String(selectedRows.length));

  const start = Math.max(0, selectedRows.length - visibleTimelineRows);
  const oldestCachedSeq = roomRows[0]?.seq ?? 0n;
  const olderRowsAvailable = start > 0 || oldestCachedSeq > 1n;
  const fragment = document.createDocumentFragment();
  if (olderRowsAvailable) {
    const historyItem = document.createElement("li");
    historyItem.dataset.slot = "timeline-history";
    historyItem.dataset.state = "available";
    const load = document.createElement("button");
    load.type = "button";
    load.dataset.loadOlderTimeline = "true";
    load.dataset.focusKey = "timeline-load-older";
    const available = start > 0
      ? Math.min(TIMELINE_PAGE_SIZE, start)
      : Number(oldestCachedSeq - 1n < BigInt(TIMELINE_PAGE_SIZE)
        ? oldestCachedSeq - 1n
        : BigInt(TIMELINE_PAGE_SIZE));
    load.textContent = `Load ${available} earlier updates`;
    historyItem.append(load);
    fragment.append(historyItem);
  }
  for (const row of selectedRows.slice(start)) {
    const entry = parseJsonRecord(row.entryJson);
    const copy = timelineCopy(row, entry);
    const item = document.createElement("li");
    item.dataset.slot = "timeline-entry";
    item.dataset.state = row.kind === "attention" ? stringValue(entry.severity) || "warning" : "recorded";
    item.dataset.kind = row.kind;
    item.dataset.entryId = row.id;

    const marker = document.createElement("span");
    marker.dataset.slot = "timeline-marker";
    marker.setAttribute("aria-hidden", "true");

    const article = document.createElement("article");
    article.dataset.slot = "timeline-card";
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = copy.title;
    const metadata = document.createElement("span");
    metadata.textContent = copy.metadata;
    const time = document.createElement("time");
    time.dateTime = new Date(Number(row.createdAt.microsSinceUnixEpoch / 1_000n)).toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(time.dateTime));
    header.append(title, metadata, time);
    const body = document.createElement("p");
    body.textContent = copy.body;
    article.append(header, body);

    if (row.nodeId) {
      const details = document.createElement("a");
      details.href = `#coding-cast-${encodeURIComponent(row.nodeId)}`;
      details.dataset.coordinationSelectNode = row.nodeId;
      details.dataset.focusKey = `activity-${row.id}`;
      details.textContent = `View ${castName(row.nodeId)}`;
      article.append(details);
    }
    item.append(marker, article);
    fragment.append(item);
  }
  const renderKey = `${start}:${selectedRows.slice(start).map((row) =>
    `${row.id}:${row.seq.toString()}`).join("|")}`;
  if (list.dataset.renderKey !== renderKey) {
    list.dataset.renderKey = renderKey;
    list.replaceChildren(fragment);
  }
  const oldest = selectedRows[start]?.seq.toString() ?? "0";
  list.dataset.cursor = oldest;
  list.dataset.oldestCachedSeq = oldestCachedSeq.toString();
  try {
    sessionStorage.setItem(`${CURSOR_STORAGE_PREFIX}:${roomId}`, oldest);
  } catch {
    // Cursor persistence is a convenience; sequence identity remains durable.
  }
};

type RealtimeConversationMessage = {
  readonly rowId: string;
  readonly seq: bigint;
  readonly occurredAtMs: bigint;
  readonly intentId: string;
  readonly messageId: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly externalId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly authorKind: "user" | "agent" | "system";
  readonly text: string;
  readonly meta?: string;
  readonly tags: ReadonlyArray<string>;
  readonly mentions: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<{
    readonly name: string;
    readonly dataUrl: string;
  }>;
};

const stringList = (value: unknown, limit = 24): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, limit)
    : [];

const realtimeConversationMessage = (row: TimelineRow): RealtimeConversationMessage | undefined => {
  if (row.kind !== "message") return undefined;
  const entry = parseJsonRecord(row.entryJson);
  const payload = record(entry.payload);
  const message = record(payload?.message);
  const author = record(message?.author);
  const source = record(message?.source);
  const messageId = stringValue(message?.messageId);
  const text = stringValue(message?.text);
  if (!message || !messageId || !text || !author) return undefined;
  const declaredKind = stringValue(author.kind);
  const authorKind = declaredKind === "user" || declaredKind === "agent" ? declaredKind : "system";
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.flatMap((value) => {
        const attachment = record(value);
        const dataUrl = stringValue(attachment?.dataUrl);
        if (!dataUrl.startsWith("data:image/")) return [];
        return [{
          name: stringValue(attachment?.name) || "Attached image",
          dataUrl,
        }];
      }).slice(0, 4)
    : [];
  return {
    rowId: row.id,
    seq: row.seq,
    occurredAtMs: row.createdAt.microsSinceUnixEpoch / 1_000n,
    intentId: stringValue(entry.intentId) || messageId,
    messageId,
    taskId: row.taskId,
    artifactId: stringValue(entry.artifactId) || stringValue(source?.externalId),
    externalId: stringValue(source?.externalId),
    authorId: stringValue(author.id),
    authorName: stringValue(author.name) || (authorKind === "user" ? "You" : "Roster"),
    authorKind,
    text,
    tags: stringList(message.tags),
    mentions: stringList(message.mentions, 12),
    attachments,
  };
};

const renderRealtimeConversationMessages = (): void => {
  const feed = document.querySelector<HTMLOListElement>("#coding-conversation-feed");
  if (!feed) return;
  const currentStatusAnchor = (): HTMLElement | null => feed.querySelector<HTMLElement>(
    "[data-coding-live-attention], .coding-inline-reply, [data-coding-run-progress]",
  );
  const authoredMessages = [...timeline.values()]
    .filter((row) => row.roomId === roomId && (!activeRunId || !row.runId || row.runId === activeRunId))
    .flatMap((row) => {
      const message = realtimeConversationMessage(row);
      return message ? [message] : [];
    });
  const allMessages = authoredMessages
    .sort((left, right) => left.occurredAtMs < right.occurredAtMs
      ? -1
      : left.occurredAtMs > right.occurredAtMs
        ? 1
        : left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.rowId.localeCompare(right.rowId));
  const selected = allMessages;
  const projection = roomSocialProjectionInputs();
  const participantIdByLabel = new Map(projection.participants.flatMap((participant) => [
    [participant.nodeId.toLocaleLowerCase(), participant.nodeId],
    [participant.displayName.toLocaleLowerCase(), participant.nodeId],
    [`@${participant.displayName.toLocaleLowerCase()}`, participant.nodeId],
  ]));
  const tasksForProjection = [...projection.tasks];
  const edgesForProjection = [...projection.edges];
  for (const message of selected) {
    if ((!message.tags.includes("turn:final-result")
      && !message.tags.includes("turn:investigation-synthesis")) || !message.taskId) continue;
    const deliveryTaskId = `social-delivery:${message.taskId}`;
    tasksForProjection.push({ taskId: deliveryTaskId, nodeId: "human.operator", state: "pending" });
    edgesForProjection.push({ taskId: deliveryTaskId, prerequisiteTaskId: message.taskId });
  }
  const durableInputs: CodingSocialDurableTimelineInput[] = selected.map((message) => {
    const accepted = message.tags.includes("protocol:agent-turn")
      && Boolean(message.taskId)
      && Boolean(message.artifactId);
    const authorNodeId = message.authorId
      || (message.authorKind === "user" ? "human.operator" : message.authorKind === "system" ? "coordinator" : "")
      || participantIdByLabel.get(message.authorName.toLocaleLowerCase())
      || profileNodeIdForName(message.authorName);
    return {
      sourceId: message.messageId,
      sourceSequence: message.seq.toString(),
      at: new Date(Number(message.occurredAtMs)).toISOString(),
      authorNodeId,
      recipientNodeIds: message.mentions.flatMap((mention) =>
        participantIdByLabel.get(mention.trim().toLocaleLowerCase()) ?? []),
      body: message.text,
      sourceKind: accepted ? "accepted-summary" : "message",
      ...(accepted ? {
        taskId: message.taskId,
        artifactId: message.artifactId,
        outputReference: message.artifactId,
      } : {}),
    };
  });
  const rows = projectCodingDurableTimelineRows({
    ...projection,
    tasks: tasksForProjection,
    edges: edgesForProjection,
    messages: durableInputs,
  }) as CodingSocialUpsertRow[];
  const selectedRowIds = new Set(rows.map((row) => row.rowId));
  for (const stale of feed.querySelectorAll<HTMLElement>("[data-realtime-durable-row]")) {
    if (!selectedRowIds.has(stale.dataset.rowId ?? "")) stale.closest("li")?.remove();
  }
  for (const row of rows) {
    const message = selected.find((candidate) =>
      candidate.messageId === row.sourceId || candidate.artifactId === row.sourceId);
    if (!message) continue;
    const rowSelector = `[data-coding-social-row][data-row-id="${CSS.escape(row.rowId)}"]`;
    const messageSelector = `[data-coding-message-id="${CSS.escape(message.messageId)}"]`;
    const externalSelector = message.externalId
      ? `[data-coding-external-id="${CSS.escape(message.externalId)}"]`
      : "";
    let article = feed.querySelector<HTMLElement>(rowSelector);
    const optimistic = article
      ? undefined
      : feed.querySelector<HTMLElement>(messageSelector)
        ?? (externalSelector ? feed.querySelector<HTMLElement>(externalSelector) : null);
    if (!article) {
      const item = codingSocialRowElement(row, message);
      article = item.querySelector<HTMLElement>("[data-coding-social-row]")!;
      const optimisticItem = optimistic?.closest("li");
      if (optimisticItem) optimisticItem.replaceWith(item);
      else feed.insertBefore(item, currentStatusAnchor());
    }
    article.dataset.realtimeDurableRow = "true";
    article.dataset.codingMessageId = message.messageId;
    if (message.externalId) article.dataset.codingExternalId = message.externalId;
    if (message.authorId) article.dataset.participantId = message.authorId;
    const intent = [...intents.values()].find((candidate) =>
      candidate.roomId === roomId
      && (candidate.intentId === message.intentId || candidate.intentId === message.messageId));
    const terminal = ["complete", "needs-attention", "stopped"].includes(activeRunPresentation().state);
    let delivery = article.querySelector<HTMLElement>(".coding-message-delivery");
    if (!message.tags.includes("delivery:queued")) {
      delivery?.remove();
      delete article.dataset.deliveryState;
      continue;
    }
    if (!delivery) {
      delivery = document.createElement("small");
      delivery.className = "coding-message-delivery";
      delivery.setAttribute("role", "status");
      delivery.setAttribute("aria-live", "polite");
      article.querySelector(".coding-message-content")?.append(delivery);
    }
    const deliveryState = intent?.status === "consumed" ? "consumed" : terminal ? "superseded" : "queued";
    delivery.textContent = deliveryState === "consumed"
      ? "Delivered to the working team"
      : deliveryState === "superseded"
        ? "Run ended before this message was delivered"
        : "Message queued for the team";
    article.dataset.deliveryState = deliveryState;
  }
};

const renderFrontier = (): void => {
  const frontier = [...frontiers.values()]
    .filter((row) => row.roomId === roomId && (!activeRunId || row.runId === activeRunId))
    .sort((left, right) => left.updatedAt.microsSinceUnixEpoch > right.updatedAt.microsSinceUnixEpoch ? -1 : 1)[0];
  if (!frontier) return;
  const shell = document.querySelector<HTMLElement>("[data-slot='context-frontier']");
  replaceText("[data-frontier-context]", frontier.contextVersion);
  if (shell) shell.dataset.frontierVersion = frontier.frontierVersion;
};

type CoordinationState = CodingNodePresentationState;

const activeExecution = (): ExecutionSummaryRow | undefined =>
  [...executions.values()].find((row) => row.runId === activeRunId);

const activeJobStatus = (): boolean =>
  Boolean(boot.job && ["queued", "leased", "running"].includes(boot.job.status));

/**
 * Git and dependency preflight happens before the durable task graph exists.
 * Reconcile only that bounded gap so a terminal queue failure cannot leave the
 * realtime UI showing "Preparing" forever. Once an execution row appears,
 * SpacetimeDB remains the sole live projection authority.
 */
const schedulePreflightReconciliation = (): void => {
  if (
    disposed
    || preflightReconcileTimer
    || !activeJobStatus()
    || !boot.conversationId
    || !boot.job
    || activeExecution()
    || preflightReconcileAttempt >= 20
  ) return;
  const delay = Math.min(15_000, 2_000 * 2 ** Math.min(preflightReconcileAttempt, 3));
  preflightReconcileTimer = window.setTimeout(() => {
    preflightReconcileTimer = 0;
    if (disposed || activeExecution() || !boot.job || !boot.conversationId) return;
    preflightReconcileAttempt += 1;
    const url = `/api/v2/coding/runs/${encodeURIComponent(boot.conversationId)}`
      + `?job=${encodeURIComponent(boot.job.id)}`;
    fetch(url, { cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (response) => response.ok ? response.json() as Promise<unknown> : undefined)
      .then((payload) => {
        if (disposed || activeExecution()) return;
        const projection = record(payload);
        const job = record(projection?.job);
        const status = stringValue(job?.status);
        if (["completed", "failed", "canceled"].includes(status)) {
          location.reload();
          return;
        }
        schedulePreflightReconciliation();
      })
      .catch(() => schedulePreflightReconciliation());
  }, delay);
};

const timestampMillis = (value: TimestampLike | undefined): number => value
  ? Number(value.microsSinceUnixEpoch / 1_000n)
  : 0;

const latestActiveRunActivityAt = (): number => Math.max(
  timestampMillis(activeExecution()?.updatedAt),
  ...[...tasks.values()]
    .filter((row) => row.runId === activeRunId)
    .map((row) => timestampMillis(row.updatedAt)),
  ...[...timeline.values()]
    .filter((row) => row.runId === activeRunId)
    .map((row) => timestampMillis(row.createdAt)),
  ...[...outputReferences.values()]
    .filter((row) => row.runId === activeRunId)
    .map((row) => timestampMillis(row.createdAt)),
);

type LiveDeliveryDisposition = {
  readonly action: "keep-branch";
  readonly jobId: string;
  readonly branch: string;
};

const activeDeliveryDisposition = (): LiveDeliveryDisposition | undefined =>
  boot.delivery?.status === "kept-branch" && boot.job?.id && boot.delivery.branch
    ? { action: "keep-branch", jobId: boot.job.id, branch: boot.delivery.branch }
    : undefined;

const activeRunPresentation = (): CodingRunPresentation => {
  const execution = activeExecution();
  const presentation = codingRunPresentation(execution, [...tasks.values()]
    .filter((task) => task.runId === activeRunId)
    .map((task) => ({
      taskId: task.taskId,
      nodeId: task.nodeId,
      capability: task.capability,
      status: task.status,
      displayName: nodes.get(task.nodeId)?.name.split(",", 1)[0] || task.nodeId,
      ...(task.failureCategory ? { failureCategory: task.failureCategory } : {}),
      ...(task.failureReason ? { failureReason: task.failureReason } : {}),
    })), boot.job?.status);
  const delivery = boot.delivery;
  const disposition = activeDeliveryDisposition();
  const executionFinished = presentation.state === "complete" || boot.committedUsageNote;
  if (disposition || delivery?.status === "kept-branch") {
    const branch = disposition?.branch || delivery?.branch || "the certified run branch";
    return {
      state: "complete",
      label: "Closed · branch kept",
      summary: `This room is closed without merging. The certified code remains on ${branch}.`,
      progress: presentation.progress,
      needsAttention: false,
    };
  }
  if (
    presentation.state === "complete"
    && delivery?.status === "working"
    && activeRunId
    && !terminalDeliveryRefreshScheduled
  ) {
    terminalDeliveryRefreshScheduled = true;
    const key = `roster.coding.delivery-refresh.v1:${activeRunId}`;
    if (sessionStorage.getItem(key) !== "done") {
      sessionStorage.setItem(key, "done");
      // SpacetimeDB is the wake-up signal. One terminal-boundary navigation
      // reconciles the server-owned Git projection without status polling.
      setTimeout(() => {
        if (!disposed) location.reload();
      }, 750);
    }
  }
  if (!delivery || (!executionFinished && delivery.status === "working")) return presentation;
  const target = delivery.targetBranch || "the target branch";
  if (delivery.status === "integrated") {
    return {
      state: "complete",
      label: "Merged",
      summary: `The certified change is now on ${target}.`,
      progress: presentation.progress,
      needsAttention: false,
    };
  }
  if (delivery.status === "no-changes") {
    return {
      state: "complete",
      label: "Complete",
      summary: "The team finished. No repository changes were needed.",
      progress: presentation.progress,
      needsAttention: false,
    };
  }
  if (delivery.status === "ready") {
    return {
      state: "waiting",
      label: "Ready to merge",
      summary: `The change is certified. Merge it into ${target} to finish this run.`,
      progress: presentation.progress,
      needsAttention: false,
    };
  }
  if (delivery.status === "blocked" || delivery.status === "unavailable") {
    return {
      state: "needs-attention",
      label: "Needs attention",
      summary: delivery.reason || "The change is certified, but its merge handoff is blocked.",
      progress: execution ? presentation.progress : "Stopped before the first step",
      needsAttention: true,
    };
  }
  if (executionFinished) {
    return {
      state: "working",
      label: "Finalizing delivery",
      summary: "The change is certified. Roster is preparing the exact commit for merge.",
      progress: presentation.progress,
      needsAttention: false,
    };
  }
  return presentation;
};

const capabilityLabel = (capability: string): string => {
  const normalized = capability.toLowerCase();
  if (normalized.includes("remediate")) return "Remediation";
  if (normalized.includes("implement") || normalized.includes("mutate")) return "Implementation";
  if (normalized.includes("certif")) return "Certification";
  if (normalized.includes("review")) return "Review";
  if (normalized.includes("validat")) return "Validation";
  if (normalized.includes("propos")) return "Design direction";
  return capability
    .replaceAll(/[._:-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    || "Assigned work";
};

const nodeRole = (node: RoomNodeRow): string => {
  if (resolutionReviewerNode(node)) return "Run-scoped conflict review";
  const nameRole = node.name.split(",").slice(1).join(",").trim();
  if (nameRole) return nameRole;
  try {
    const capabilities = JSON.parse(node.capabilitiesJson);
    if (Array.isArray(capabilities) && typeof capabilities[0] === "string") return capabilities[0];
  } catch {
    // A malformed presentation field must not disturb the durable room projection.
  }
  return "Coding specialist";
};

const actionableAttentionCopy = (reason: string): string => {
  const normalized = reason.toLowerCase();
  if (normalized.includes("budget") || normalized.includes("usage") || normalized.includes("execution policy")) {
    return "The run reached its execution budget before finalization. @You, choose Retry Run below to start a fresh bounded attempt, or reply here with a narrower next step. Accepted contributions are preserved.";
  }
  if (normalized.includes("runtime") || normalized.includes("model") || normalized.includes("auth")) {
    return `The run stopped because an agent runtime needs to be restored: ${reason}. @You, restore or choose an available runtime, then choose Retry Run below—or reply here with a different direction.`;
  }
  if (normalized.includes("conflict")) {
    return `The team found a decision it cannot resolve safely: ${reason}. @You, reply here with the choice you want, or choose Retry Run below after the conflict is resolved.`;
  }
  if (normalized.includes(" step failed") || normalized.includes(" step did not finish") || normalized.includes(" step stopped")) {
    return `${reason} @You, choose Retry Run below to start a fresh bounded attempt, or reply here with a narrower next step. Every accepted contribution is preserved.`;
  }
  return `The run stopped before the team could finish: ${reason}. @You, choose Retry Run below to start a fresh bounded attempt, or reply here with new direction.`;
};

const certifiedDeliveryNeedsAttention = (): boolean => Boolean(
  !activeDeliveryDisposition()
  &&
  boot.delivery?.certified
  && (boot.delivery.status === "blocked" || boot.delivery.status === "unavailable"),
);

const renderConversationLiveActivity = (): void => {
  const feed = document.querySelector<HTMLOListElement>("#coding-conversation-feed");
  if (!feed) return;
  const runTasks = [...tasks.values()]
    .filter((task) => task.runId === activeRunId)
    .filter(isCodingUserVisibleTask);
  const runningTasks = runTasks.filter((task) => task.status === "running" || task.status === "leased");
  const activeTasks = runningTasks.length > 0
    ? runningTasks
    : runTasks.filter((task) => task.status === "ready");
  const seenNodes = new Set<string>();
  const activities = activeTasks.flatMap((task) => {
    if (seenNodes.has(task.nodeId)) return [];
    seenNodes.add(task.nodeId);
    const logs = [...runtimeLogs.values()]
      .filter((entry) => entry.runId === activeRunId
        && entry.nodeId === task.nodeId
        && entry.taskId === task.taskId)
      .sort((left, right) => left.sequence - right.sequence);
    const node = nodes.get(task.nodeId);
    return [codingLiveActivityPresentation({
      nodeId: task.nodeId,
      displayName: node?.name.split(",", 1)[0] || task.nodeId,
      capability: task.capability,
      phase: task.status === "ready" ? "queued" : "active",
      signalCount: logs.length,
      ...(logs.at(-1) ? { lastSignalAt: logs.at(-1)!.at } : {}),
    })];
  });
  let item = feed.querySelector<HTMLLIElement>("[data-coding-live-activity]");
  if (activities.length === 0) {
    item?.remove();
    return;
  }
  if (!item) {
    item = document.createElement("li");
    item.className = "coding-live-activity-item";
    item.dataset.codingLiveActivity = "true";
    item.dataset.conversationKind = "activity-event";
    const article = document.createElement("article");
    article.className = "coding-live-activity";
    article.setAttribute("aria-live", "polite");
    article.setAttribute("aria-atomic", "true");
    const header = document.createElement("header");
    const marker = document.createElement("i");
    marker.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = "Live activity";
    const source = document.createElement("span");
    source.textContent = "Roster system update";
    header.append(marker, title, source);
    article.append(header, document.createElement("ul"));
    item.append(article);
  }
  const anchor = feed.querySelector<HTMLElement>(
    "[data-coding-live-attention], .coding-inline-reply, .coding-room-delivery, [data-coding-run-progress]",
  );
  if (!item.isConnected || item.nextElementSibling !== anchor) feed.insertBefore(item, anchor);
  const list = item.querySelector<HTMLUListElement>("ul");
  if (!list) return;
  const fragment = document.createDocumentFragment();
  for (const activity of activities) {
    const row = document.createElement("li");
    row.dataset.nodeId = activity.nodeId;
    const person = document.createElement("strong");
    person.textContent = activity.displayName;
    const state = document.createElement("span");
    state.textContent = activity.activity;
    const detail = document.createElement("small");
    if (activity.signalCount > 0 && activity.lastSignalAt !== undefined) {
      const time = new Date(activity.lastSignalAt);
      detail.textContent = `${activity.signalCount} runtime signal${activity.signalCount === 1 ? "" : "s"} · latest `;
      const timestamp = document.createElement("time");
      timestamp.dateTime = time.toISOString();
      timestamp.textContent = time.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      detail.append(timestamp);
    } else {
      detail.textContent = activity.activity.startsWith("Queued")
        ? "Waiting for an available worker"
        : runtimeLogState === "paused"
          ? "Activity stream reconnecting"
          : "Waiting for the first runtime signal";
    }
    row.append(person, state, detail);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
};

const renderLiveAttention = (presentation: CodingRunPresentation): void => {
  const feed = document.querySelector<HTMLOListElement>("#coding-conversation-feed");
  if (!feed) return;
  const existing = feed.querySelector<HTMLElement>("[data-coding-live-attention]");
  if (!presentation.needsAttention) {
    existing?.remove();
    return;
  }
  let item = existing;
  if (!item) {
    item = document.createElement("li");
    item.className = "coding-message system";
    item.dataset.codingLiveAttention = "true";
    const avatar = document.createElement("span");
    avatar.className = "coding-message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "R";
    const article = document.createElement("article");
    article.setAttribute("role", "alert");
    article.setAttribute("aria-atomic", "true");
    const header = document.createElement("header");
    const author = document.createElement("strong");
    author.append(participantTrigger({
      nodeId: "coordinator",
      name: "Roster",
      role: "System Facilitator",
      kind: "system",
    }));
    const role = document.createElement("span");
    role.className = "coding-agent-role";
    role.textContent = "System Facilitator";
    const state = document.createElement("span");
    state.textContent = "Needs attention";
    const address = document.createElement("span");
    address.className = "coding-message-address";
    renderMessageAddress(address, ["You"]);
    header.append(author, role, state, address);
    const copy = document.createElement("div");
    copy.className = "coding-message-body";
    const paragraph = document.createElement("p");
    paragraph.dataset.codingAttentionCopy = "true";
    copy.append(paragraph);
    article.append(header, copy);
    item.append(avatar, article);
    feed.insertBefore(item, feed.querySelector(".coding-inline-reply, [data-coding-run-progress]"));
  }
  const statusAnchor = feed.querySelector<HTMLElement>(".coding-inline-reply, [data-coding-run-progress]");
  if (item.nextElementSibling !== statusAnchor) feed.insertBefore(item, statusAnchor);
  const copy = item.querySelector<HTMLElement>("[data-coding-attention-copy]")
    ?? item.querySelector<HTMLElement>(".coding-message-body p");
  const nextCopy = certifiedDeliveryNeedsAttention()
    ? `@You, the change is certified, but the merge needs attention: ${presentation.summary}`
    : actionableAttentionCopy(presentation.summary);
  if (copy && copy.textContent !== nextCopy) copy.textContent = nextCopy;
};

const removeConversationStatusSnapshots = (): void => {
  const feed = document.querySelector<HTMLOListElement>("#coding-conversation-feed");
  if (!feed) return;
  // A teammate's current task state is a mutable run projection. It lives in
  // the collaboration plan, never among chronological conversation posts.
  for (const snapshot of feed.querySelectorAll<HTMLElement>("[data-coding-team-snapshot]")) {
    snapshot.remove();
  }
};
const latestBindingFor = (nodeId: string): RuntimeBindingRow | undefined =>
  [...bindings.values()]
    .filter((candidate) =>
      candidate.roomId === roomId
      && candidate.nodeId === nodeId
      && (!activeRunId || !candidate.runId || candidate.runId === activeRunId))
    .sort((left, right) => left.epoch > right.epoch ? -1 : left.epoch < right.epoch ? 1 : 0)[0];

const nodeRuntimeIdentity = (_node: RoomNodeRow, binding: RuntimeBindingRow | undefined): {
  readonly runtime: string;
  readonly model: string;
  readonly modelBacked: boolean;
} => {
  const active = codingNodeExecutionIdentity(binding);
  return {
    runtime: active?.runtime ?? "Agent binding pending",
    model: active?.model ?? "Model pending",
    modelBacked: Boolean(active && binding?.runtimeKind !== "shell" && binding?.model),
  };
};

const taskIdFromKey = (key: string, taskByKey: ReadonlyMap<string, TaskRow>): string | undefined =>
  taskByKey.get(key)?.taskId
  ?? [...taskByKey.values()].find((task) => key === task.id || key.endsWith(`:${task.taskId}`))?.taskId;

const ROOM_UPDATE_SNAPSHOT_LIMIT = 500;
const ROOM_UPDATE_RECORD_FIELDS = new Set(["type", "update"]);
const ROOM_UPDATE_SNAPSHOT_FIELDS = new Set(["type", "updates"]);
const ROOM_UPDATE_HEARTBEAT_FIELDS = new Set(["type", "at"]);

const exactFields = (value: Readonly<Record<string, unknown>>, allowlist: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowlist.has(key))
  && Object.keys(value).length === allowlist.size;

const socialParticipantForNode = (node: RoomNodeRow): CodingSocialParticipant => {
  const profile = [...participantProfiles.values()].find((candidate) => candidate.nodeId === node.nodeId);
  const presentationName = profile?.displayName || nodePresentationName(node);
  const displayName = presentationName.split(",", 1)[0]?.trim() || presentationName;
  return {
    nodeId: node.nodeId,
    displayName,
    role: profile?.role || nodeRole(node),
    avatarLabel: (displayName[0] || "?").toUpperCase(),
    human: false,
  };
};

const roomSocialProjectionInputs = (): {
  readonly participants: CodingSocialParticipant[];
  readonly tasks: CodingSocialTaskInput[];
  readonly edges: CodingSocialTaskEdgeInput[];
} => {
  const runTasks = [...tasks.values()].filter((task) => task.runId === activeRunId);
  const taskByKey = new Map(runTasks.map((task) => [task.id, task]));
  const participants: CodingSocialParticipant[] = [{
    nodeId: "human.operator",
    displayName: "You",
    role: "Workspace participant",
    avatarLabel: "Y",
    human: true,
  }, {
    nodeId: "coordinator",
    displayName: "Roster",
    role: "System Facilitator",
    avatarLabel: "R",
    human: false,
  }, ...[...nodes.values()]
    .filter((node) => node.roomId === roomId && (!node.runId || node.runId === activeRunId))
    .filter((node) => node.nodeId !== "human.operator" && node.nodeId !== "coordinator")
    .map(socialParticipantForNode)];
  const projectedTasks: CodingSocialTaskInput[] = runTasks.map((task) => ({
    taskId: task.taskId,
    nodeId: task.nodeId,
    state: task.status === "accepted" || task.status === "skipped"
      ? "accepted"
      : task.status === "failed" || task.status === "canceled"
        ? "failed"
        : task.status === "running" || task.status === "leased"
          ? "running"
          : "pending",
  }));
  const edges = new Map<string, CodingSocialTaskEdgeInput>();
  for (const edge of taskEdges.values()) {
    if (edge.runId !== activeRunId) continue;
    const taskId = taskIdFromKey(edge.taskKey, taskByKey);
    const prerequisiteTaskId = taskIdFromKey(edge.prerequisiteTaskKey, taskByKey);
    if (taskId && prerequisiteTaskId) edges.set(`${taskId}\u0000${prerequisiteTaskId}`, {
      taskId,
      prerequisiteTaskId,
    });
  }
  return { participants, tasks: projectedTasks, edges: [...edges.values()] };
};

const roomUpdateValidationContext = (): CodingRoomUpdateValidationContext => {
  const projection = roomSocialProjectionInputs();
  return {
    runId: activeRunId,
    participants: projection.participants.map((participant) => ({
      nodeId: participant.nodeId,
      human: participant.human,
    })),
    tasks: projection.tasks.map((task) => ({ taskId: task.taskId, nodeId: task.nodeId })),
    edges: projection.edges,
  };
};

const parsePublicRoomUpdate = (value: unknown): NodeRoomUpdate | undefined =>
  parseCodingRoomUpdate(value, roomUpdateValidationContext());

const durableSocialRowsFromDom = (): CodingSocialUpsertRow[] => {
  const participants = new Map(roomSocialProjectionInputs().participants.map((participant) => [
    participant.nodeId,
    participant,
  ]));
  return [...document.querySelectorAll<HTMLElement>(
    '[data-coding-social-row][data-durability="durable"]',
  )].flatMap((article) => {
    const rowId = article.dataset.rowId;
    const authorNodeId = article.dataset.authorNodeId;
    const author = authorNodeId ? participants.get(authorNodeId) : undefined;
    if (!rowId || !author) return [];
    let recipientNodeIds: readonly string[] = [];
    try {
      const parsed = JSON.parse(decodeURIComponent(article.dataset.recipientNodeIds ?? ""));
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
        recipientNodeIds = parsed;
      }
    } catch {
      return [];
    }
    const recipients = recipientNodeIds.flatMap((nodeId) => participants.get(nodeId) ?? []);
    if (recipients.length !== recipientNodeIds.length) return [];
    const sourceKind = article.dataset.sourceKind;
    if (sourceKind !== "message" && sourceKind !== "accepted-summary" && sourceKind !== "system-activity") return [];
    const state = article.dataset.state;
    if (state !== "sent" && state !== "accepted" && state !== "attention") return [];
    return [{
      rowId,
      sourceId: article.dataset.sourceId || rowId,
      sourceKind,
      author,
      recipients,
      body: article.querySelector(".coding-message-body")?.textContent?.trim() || "Workspace update",
      at: article.querySelector("time")?.getAttribute("datetime") || new Date(0).toISOString(),
      state,
      durability: "durable" as const,
      cluster: article.dataset.messageGroup === "continuation" ? "continuation" as const : "start" as const,
      clusterBoundary: article.dataset.clusterBoundary === "true",
      ...(article.dataset.taskId ? { taskId: article.dataset.taskId } : {}),
    }];
  });
};

const roomUpdateStatusLabel = (row: CodingSocialUpsertRow): "Live" | "Paused" | "Settled" | "Waiting" => {
  if (row.settled) return "Settled";
  if (roomUpdateState === "paused") return "Paused";
  return row.intent === "question" ? "Waiting" : "Live";
};

const codingSocialRowElement = (
  row: CodingSocialUpsertRow,
  message?: RealtimeConversationMessage,
): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = "coding-social-item";
  const article = document.createElement("article");
  article.className = `coding-social-row${row.cluster === "continuation" ? " coding-social-row-continuation" : ""}`;
  article.dataset.codingSocialRow = "";
  article.dataset.messageGroup = row.cluster;
  article.dataset.rowId = row.rowId;
  article.dataset.sourceKind = row.sourceKind;
  article.dataset.sourceId = row.sourceId;
  article.dataset.authorNodeId = row.author.nodeId;
  article.dataset.recipientNodeIds = encodeURIComponent(JSON.stringify(
    row.recipients.map((recipient) => recipient.nodeId),
  ));
  article.dataset.clusterBoundary = String(Boolean(row.clusterBoundary));
  article.dataset.taskId = row.taskId ?? "";
  if (row.updateId) article.dataset.updateId = row.updateId;
  article.dataset.durability = row.durability;
  article.dataset.state = row.state;
  if (row.intent) {
    article.dataset.updateIntent = row.intent;
    article.dataset.updateSequence = String(row.sequence ?? 0);
    article.dataset.updateSettled = String(Boolean(row.settled));
    article.dataset.roomConnection = roomUpdateState;
  }
  if (row.state === "live") {
    article.setAttribute("aria-live", "polite");
    article.setAttribute("aria-atomic", "true");
  }
  article.setAttribute("aria-label", `${row.author.displayName}${row.cluster === "continuation" ? " continued" : ""} message`);

  const avatar = document.createElement("div");
  avatar.className = "coding-message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = row.cluster === "continuation" ? "" : row.author.avatarLabel;
  const content = document.createElement("div");
  content.className = "coding-message-content";
  const header = document.createElement("header");
  header.className = "coding-message-meta";
  const author = document.createElement("strong");
  if (row.cluster === "continuation") author.className = "sr-only";
  author.append(participantTrigger({
    nodeId: row.author.nodeId,
    name: row.author.displayName,
    kind: row.author.human ? "user" : row.author.nodeId === "coordinator" ? "system" : "agent",
  }));
  const role = document.createElement("span");
  role.className = "coding-agent-role";
  role.textContent = row.author.role;
  const time = document.createElement("time");
  const timestamp = new Date(row.at);
  time.dateTime = Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : row.at;
  time.textContent = Number.isFinite(timestamp.valueOf())
    ? `${String(timestamp.getUTCHours()).padStart(2, "0")}:${String(timestamp.getUTCMinutes()).padStart(2, "0")}`
    : "—";
  header.append(author);
  if (row.cluster === "start") header.append(role, time);
  if (row.sourceKind === "live-update") {
    const live = document.createElement("span");
    live.className = "coding-live-label";
    const label = roomUpdateStatusLabel(row);
    if (label === "Live" || label === "Waiting") {
      const dot = document.createElement("i");
      dot.className = "coding-live-dot";
      dot.setAttribute("aria-hidden", "true");
      live.append(dot);
    }
    live.append(label);
    header.append(live);
  }
  if (row.recipients.length > 0) {
    const recipients = document.createElement("span");
    recipients.className = "coding-message-recipients";
    recipients.append("to ");
    for (const recipient of row.recipients) {
      const mention = document.createElement("span");
      mention.className = "coding-message-recipient";
      mention.textContent = `@${recipient.displayName}`;
      recipients.append(mention);
    }
    header.append(recipients);
  }
  content.append(header);

  const body = document.createElement("div");
  body.className = "coding-message-body";
  const paragraph = document.createElement("p");
  paragraph.textContent = row.body;
  body.append(paragraph);
  content.append(body);

  if (message?.attachments.length) {
    const gallery = document.createElement("div");
    gallery.className = "coding-message-images";
    gallery.dataset.slot = "chat-image-gallery";
    for (const attachment of message.attachments) {
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      image.src = attachment.dataUrl;
      image.alt = `Attached image: ${attachment.name}`;
      image.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = attachment.name;
      figure.append(image, caption);
      gallery.append(figure);
    }
    content.append(gallery);
  }

  const details = document.createElement("details");
  details.className = "coding-message-evidence";
  details.dataset.detailsKey = `coding-social-${row.rowId}`;
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  const detailBody = document.createElement("div");
  const list = document.createElement("dl");
  for (const [termText, detailText] of [
    ["Source", row.sourceKind],
    ["Durability", row.durability],
    ["State", row.sourceKind === "live-update" ? roomUpdateStatusLabel(row) : row.state],
    ["Intent", row.intent ?? ""],
    ["Task", row.taskId ?? ""],
  ]) {
    if (!detailText) continue;
    const definition = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = termText;
    const detail = document.createElement("dd");
    detail.textContent = detailText;
    definition.append(term, detail);
    list.append(definition);
  }
  detailBody.append(list);
  details.append(summary, detailBody);
  content.append(details);
  article.append(avatar, content);
  item.append(article);
  return item;
};

const updateNewSocialMessageCount = (newRows: number, followEnd: boolean): void => {
  const control = document.querySelector<HTMLButtonElement>("[data-coding-new-messages]");
  if (!control) return;
  if (followEnd) {
    control.hidden = true;
    delete control.dataset.count;
    return;
  }
  if (newRows < 1) return;
  const count = Math.max(0, Number(control.dataset.count ?? "0")) + newRows;
  control.dataset.count = String(count);
  const label = control.querySelector<HTMLElement>("span:last-child");
  if (label) label.textContent = count === 1 ? "New message" : `${count} new messages`;
  control.hidden = false;
};

const renderRoomUpdates = (): void => {
  const feed = document.querySelector<HTMLOListElement>("[data-coding-room-transcript]");
  const scroller = feed?.closest<HTMLElement>(".coding-conversation-scroll");
  if (!feed || !scroller || !activeRunId) return;
  const projection = roomSocialProjectionInputs();
  if (roomUpdates.size > 0 && projection.tasks.length === 0) return;
  const projected = projectCodingSocialRows({
    ...projection,
    messages: [],
    acceptedSummaries: [],
    systemActivities: [],
    roomUpdates: [...roomUpdates.values()],
  }) as CodingSocialUpsertRow[];
  const nextRows = reconcileCodingLiveSocialRows({
    existingLiveRows: renderedRoomUpdateRows,
    projectedLiveRows: projected,
    durableRows: durableSocialRowsFromDom(),
  });
  const previousRows = renderedRoomUpdateRows;
  const nextIds = new Set(nextRows.map((row) => row.rowId));
  const bottomDistance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const followEnd = bottomDistance <= 80;
  const viewportTop = scroller.getBoundingClientRect().top;
  const anchor = followEnd ? undefined : [...feed.children]
    .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
    .find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1);
  const anchorRowId = anchor?.querySelector<HTMLElement>("[data-row-id]")?.dataset.rowId;
  const anchorOffset = anchor?.getBoundingClientRect().top;
  let newRows = 0;
  const statusAnchor = feed.querySelector<HTMLElement>(
    "[data-coding-live-attention], .coding-inline-reply, .coding-room-delivery, [data-coding-run-progress]",
  );
  for (const row of nextRows) {
    let existing = feed.querySelector<HTMLElement>(
      `[data-coding-social-row][data-row-id="${CSS.escape(row.rowId)}"]`,
    )?.closest<HTMLLIElement>("li");
    if (!existing && row.intent !== "question" && row.taskId) {
      const replaced = previousRows.find((candidate) => candidate.sourceKind === "live-update"
        && candidate.intent !== "question"
        && candidate.author.nodeId === row.author.nodeId
        && candidate.taskId === row.taskId);
      if (replaced) existing = feed.querySelector<HTMLElement>(
        `[data-coding-social-row][data-row-id="${CSS.escape(replaced.rowId)}"]`,
      )?.closest<HTMLLIElement>("li");
    }
    const item = codingSocialRowElement(row);
    if (existing) existing.replaceWith(item);
    else {
      feed.insertBefore(item, statusAnchor);
      newRows += 1;
    }
  }
  for (const stale of feed.querySelectorAll<HTMLElement>(
    '[data-coding-social-row][data-source-kind="live-update"]',
  )) {
    if (!nextIds.has(stale.dataset.rowId ?? "")) stale.closest("li")?.remove();
  }
  renderedRoomUpdateRows = nextRows;
  if (followEnd) scroller.scrollTop = scroller.scrollHeight;
  else if (anchor && anchorOffset !== undefined) {
    const nextAnchor = anchorRowId
      ? feed.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(anchorRowId)}"]`)?.closest<HTMLElement>("li")
      : anchor.isConnected ? anchor : undefined;
    if (nextAnchor) scroller.scrollTop += nextAnchor.getBoundingClientRect().top - anchorOffset;
  }
  updateNewSocialMessageCount(newRows, followEnd);
};

const scheduleRoomUpdateRender = (): void => {
  if (disposed || roomUpdateRenderFrame) return;
  roomUpdateRenderFrame = window.requestAnimationFrame(() => {
    roomUpdateRenderFrame = 0;
    renderRoomUpdates();
  });
};

const taskStages = (
  runTasks: ReadonlyArray<TaskRow>,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyMap<string, number> => {
  const stages = new Map<string, number>();
  const visiting = new Set<string>();
  const stageFor = (taskId: string): number => {
    const known = stages.get(taskId);
    if (known !== undefined) return known;
    if (visiting.has(taskId)) return 0;
    visiting.add(taskId);
    const prerequisiteStages = (dependencies.get(taskId) ?? []).map(stageFor);
    visiting.delete(taskId);
    const stage = prerequisiteStages.length > 0 ? Math.max(...prerequisiteStages) + 1 : 0;
    stages.set(taskId, stage);
    return stage;
  };
  for (const task of runTasks) stageFor(task.taskId);
  return stages;
};

const renderLiveDag = (runTasks: ReadonlyArray<TaskRow>): void => {
  const dag = document.querySelector<HTMLDetailsElement>("[data-coding-coordination-dag]");
  const body = dag?.querySelector<HTMLElement>("[data-coding-dag-body]");
  if (!dag || !body) return;
  const taskByKey = new Map(runTasks.map((task) => [task.id, task]));
  const dependencies = new Map<string, string[]>();
  const runEdges = [...taskEdges.values()].filter((edge) => edge.runId === activeRunId);
  for (const edge of runEdges) {
    const dependentId = taskIdFromKey(edge.taskKey, taskByKey);
    const prerequisiteId = taskIdFromKey(edge.prerequisiteTaskKey, taskByKey);
    if (!dependentId || !prerequisiteId) continue;
    dependencies.set(dependentId, [...new Set([...(dependencies.get(dependentId) ?? []), prerequisiteId])]);
  }
  const stages = taskStages(runTasks, dependencies);
  const tasksByStage = new Map<number, TaskRow[]>();
  for (const task of runTasks) {
    const stage = stages.get(task.taskId) ?? 0;
    tasksByStage.set(stage, [...(tasksByStage.get(stage) ?? []), task]);
  }
  const taskById = new Map(runTasks.map((task) => [task.taskId, task]));
  const nodeById = new Map([...nodes.values()].map((node) => [node.nodeId, node]));
  const statusLabel = (status: string): string => {
    if (status === "running" || status === "leased") return "In progress";
    if (status === "accepted") return "Accepted";
    if (status === "failed" || status === "canceled") return "Needs attention";
    if (status === "ready") return "Ready";
    if (status === "skipped") return "Skipped";
    return "Waiting";
  };
  const stagesList = document.createElement("ol");
  stagesList.className = "coding-dag-stages";
  stagesList.setAttribute("aria-label", "Live dynamic task DAG");
  for (const [stage, stageTasks] of [...tasksByStage.entries()].sort(([left], [right]) => left - right)) {
    const stageItem = document.createElement("li");
    stageItem.className = "coding-dag-stage";
    stageItem.dataset.stage = String(stage + 1);
    const stageHeader = document.createElement("header");
    const stageName = document.createElement("span");
    stageName.textContent = `Step ${stage + 1}`;
    const stageMeta = document.createElement("small");
    stageMeta.textContent = stageTasks.length > 1 ? `${stageTasks.length} parallel tasks` : "1 task";
    stageHeader.append(stageName, stageMeta);
    const taskList = document.createElement("ul");
    for (const task of [...stageTasks].sort((left, right) => left.taskId.localeCompare(right.taskId))) {
      const taskItem = document.createElement("li");
      taskItem.className = "coding-dag-task";
      taskItem.dataset.taskId = task.taskId;
      taskItem.dataset.state = task.status;
      const header = document.createElement("header");
      const name = document.createElement("strong");
      name.textContent = capabilityLabel(task.taskId);
      const status = document.createElement("span");
      status.textContent = statusLabel(task.status);
      header.append(name, status);
      const owner = document.createElement("small");
      owner.textContent = `${nodeById.get(task.nodeId)?.name.split(",", 1)[0] || task.nodeId} · ${capabilityLabel(task.capability)}`;
      const source = document.createElement("p");
      const sourceLabel = document.createElement("span");
      const prerequisiteNames = (dependencies.get(task.taskId) ?? [])
        .map((taskId) => taskById.get(taskId))
        .filter((task): task is TaskRow => Boolean(task))
        .map((task) => capabilityLabel(task.taskId));
      sourceLabel.textContent = prerequisiteNames.length > 0 ? "From" : "Entry";
      source.append(sourceLabel, prerequisiteNames.length > 0 ? prerequisiteNames.join(" + ") : "No prerequisites");
      taskItem.append(header, owner, source);
      taskList.append(taskItem);
    }
    stageItem.append(stageHeader, taskList);
    stagesList.append(stageItem);
  }
  let nextContent: HTMLElement = stagesList;
  if (runTasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "coding-dag-empty";
    empty.textContent = "The task graph will appear when Roster materializes the run.";
    nextContent = empty;
  }
  const renderKey = [...runTasks]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => [
      task.taskId,
      task.nodeId,
      task.status,
      task.attempt.toString(),
      ...(dependencies.get(task.taskId) ?? []),
    ].join(":"))
    .join("|");
  if (body.dataset.renderKey !== renderKey) {
    body.dataset.renderKey = renderKey;
    body.replaceChildren(nextContent);
  }
  const meta = dag.querySelector<HTMLElement>("[data-coding-dag-meta]");
  const edgeCount = [...dependencies.values()].reduce((count, taskDependencies) =>
    count + taskDependencies.length, 0);
  if (meta) meta.textContent = `${runTasks.length} tasks · ${edgeCount} edges`;
  const summary = dag.querySelector<HTMLElement>("[data-coding-dag-summary]");
  if (summary) summary.textContent = runTasks.length > 0 ? "Durable dependency path · live" : "Waiting for durable graph";
};

const renderCoordination = (): void => {
  const dock = document.querySelector<HTMLElement>("[data-coding-island='coordination-dock']");
  const body = dock?.querySelector<HTMLElement>("[data-coding-coordination-body]");

  const runTasks = [...tasks.values()]
    .filter((task) => task.runId === activeRunId);
  const visibleRunTasks = runTasks.filter(isCodingUserVisibleTask);
  renderLiveDag(visibleRunTasks);
  const taskByKey = new Map(runTasks.map((task) => [task.id, task]));
  const visibleTaskIds = new Set(visibleRunTasks.map((task) => task.taskId));
  const coordinationDependencies = new Map<string, string[]>();
  for (const edge of [...taskEdges.values()].filter((candidate) => candidate.runId === activeRunId)) {
    const dependentId = taskIdFromKey(edge.taskKey, taskByKey);
    const prerequisiteId = taskIdFromKey(edge.prerequisiteTaskKey, taskByKey);
    if (dependentId && prerequisiteId && visibleTaskIds.has(dependentId) && visibleTaskIds.has(prerequisiteId)) {
      coordinationDependencies.set(dependentId, [
        ...(coordinationDependencies.get(dependentId) ?? []),
        prerequisiteId,
      ]);
    }
  }
  const coordinationStages = taskStages(visibleRunTasks, coordinationDependencies);
  const runPresentation = activeRunPresentation();
  const selectedNodes = [...nodes.values()]
    .filter((node) => {
      if (node.roomId !== roomId || (activeRunId && node.runId && node.runId !== activeRunId)) return false;
      return node.nodeId !== "coordinator"
        && node.nodeId !== "human.operator";
    })
    .filter((node) => visibleRunTasks.some((task) => task.nodeId === node.nodeId))
    .sort((left, right) => left.name.localeCompare(right.name));

  const counts: Record<CoordinationState, number> = {
    working: 0,
    waiting: 0,
    done: 0,
    blocked: 0,
  };
  const entries = selectedNodes.map((node) => {
    const presentation = codingNodePresentation(
      visibleRunTasks.filter((candidate) => candidate.nodeId === node.nodeId),
      runPresentation,
    );
    const task = presentation.task as TaskRow | undefined;
    const state = presentation.state;
    counts[state] += 1;
    return {
      node,
      task,
      state,
      stage: Math.min(...visibleRunTasks
        .filter((candidate) => candidate.nodeId === node.nodeId)
        .map((candidate) => coordinationStages.get(candidate.taskId) ?? 0)),
      identity: nodeRuntimeIdentity(node, latestBindingFor(node.nodeId)),
    };
  }).sort((left, right) => {
    return left.stage - right.stage
      || (left.task?.taskId ?? "").localeCompare(right.task?.taskId ?? "")
      || left.node.name.localeCompare(right.node.name);
  });

  removeConversationStatusSnapshots();
  renderConversationLiveActivity();
  renderLiveAttention(runPresentation);

  const total = entries.length;
  const label = runPresentation.label;
  const activeTaskCount = visibleRunTasks.filter((task) => task.status === "running" || task.status === "leased").length;
  const readyTaskCount = visibleRunTasks.filter((task) => task.status === "ready").length;
  const namesForTaskStatus = (statuses: ReadonlySet<string>): string[] => [...new Set(visibleRunTasks
    .filter((task) => statuses.has(task.status))
    .map((task) => nodes.get(task.nodeId)?.name.split(",", 1)[0] || task.nodeId))];
  const activeNames = namesForTaskStatus(new Set(["running", "leased"]));
  const readyNames = namesForTaskStatus(new Set(["ready"]));
  const summary = runPresentation.state === "needs-attention" || runPresentation.state === "stopped"
    ? runPresentation.summary
    : activeNames.length > 0
    ? `${activeNames.join(activeNames.length === 2 ? " and " : ", ")} ${activeNames.length === 1 ? "is" : "are"} working now.`
    : readyNames.length > 0
      ? `${readyNames.join(readyNames.length === 2 ? " and " : ", ")} ${readyNames.length === 1 ? "is" : "are"} waiting for runtime capacity.`
    : total > 0 && counts.done === total
      ? "Every assigned contribution has been accepted."
      : total > 0
        ? "Named agents are ready for their next bounded task."
        : "Connecting the selected coding agent and assigning the first task.";

  const brief = document.querySelector<HTMLElement>("[data-coding-team-brief]");
  const briefCast = brief?.querySelector<HTMLElement>("[data-coding-team-brief-cast]");
  if (brief) {
    brief.dataset.state = runPresentation.state === "needs-attention" || runPresentation.state === "stopped"
      ? "blocked"
      : runPresentation.state === "complete"
        ? "done"
        : runPresentation.state === "working"
          ? "working"
          : "waiting";
    const handoff = brief.querySelector<HTMLElement>("[data-coding-team-brief-handoff]");
    if (handoff) {
      handoff.textContent = runPresentation.needsAttention
        ? `${runPresentation.summary} Every accepted contribution is preserved.`
        : activeTaskCount > 1
          ? `${activeTaskCount} steps are running independently in parallel.`
          : activeTaskCount === 1
            ? "One step is running now."
            : readyTaskCount > 1
              ? `${readyTaskCount} steps are queued and waiting for runtime capacity.`
              : readyTaskCount === 1
                ? "One step is queued and waiting for runtime capacity."
          : total > 0 && counts.done === total
            ? "Every assigned contribution is accepted and attached to this run."
            : entries.some((entry) => entry.stage > 0)
              ? "Accepted handoffs unlock the next specialist without sharing private task context."
              : "Each specialist owns one bounded contribution to the shared result.";
    }
    if (briefCast && entries.length > 0) {
      const castKey = entries.map((entry) => [
        entry.node.nodeId,
        entry.node.updatedAt.microsSinceUnixEpoch.toString(),
        entry.state,
        entry.task?.taskId ?? "",
      ].join(":")).join("|");
      if (briefCast.dataset.renderKey !== castKey) {
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
          const item = document.createElement("button");
          item.type = "button";
          item.dataset.codingOpenWork = "";
          item.dataset.state = entry.state;
          item.setAttribute("role", "listitem");
          item.setAttribute("aria-controls", "coding-context-cast");
          const name = entry.node.name.split(",", 1)[0] || entry.node.name;
          const stateLabel = entry.state === "done"
            ? "Accepted"
            : entry.state === "blocked"
              ? "Attention"
              : entry.state[0]!.toUpperCase() + entry.state.slice(1);
          item.setAttribute("aria-label", `Open team plan for ${name} — ${stateLabel}`);
          const avatar = document.createElement("span");
          avatar.className = "coding-team-brief-avatar coding-coordination-live-avatar";
          avatar.setAttribute("aria-hidden", "true");
          avatar.textContent = (name.trim()[0] || "A").toUpperCase();
          const copy = document.createElement("span");
          const strong = document.createElement("strong");
          strong.textContent = name;
          const small = document.createElement("small");
          small.textContent = nodeRole(entry.node);
          copy.append(strong, small);
          const state = document.createElement("em");
          state.textContent = stateLabel;
          item.append(avatar, copy, state);
          fragment.append(item);
        }
        briefCast.dataset.renderKey = castKey;
        briefCast.replaceChildren(fragment);
      }
    }
  }

  if (!dock || !body) return;

  dock.dataset.state = runPresentation.state === "needs-attention" || runPresentation.state === "stopped"
    ? "blocked"
    : runPresentation.state === "complete"
      ? "done"
      : runPresentation.state === "working"
        ? "working"
        : "waiting";
  const labelNode = dock.querySelector<HTMLElement>("[data-coding-coordination-label]");
  if (labelNode) labelNode.textContent = label;
  const summaryNode = dock.querySelector<HTMLElement>("[data-coding-coordination-summary]");
  if (summaryNode) summaryNode.textContent = summary;
  const displayedCounts = {
    ...counts,
    blocked: counts.blocked > 0
      ? counts.blocked
      : runPresentation.needsAttention ? 1 : 0,
  };
  for (const state of ["working", "waiting", "done", "blocked"] as const) {
    const count = dock.querySelector<HTMLElement>(`[data-coding-coordination-count="${state}"]`);
    if (count) count.textContent = String(displayedCounts[state]);
  }
  const primary = entries.find((entry) => entry.state === "working" && entry.identity.modelBacked)
    ?? entries.find((entry) => entry.identity.modelBacked);
  const primaryNode = dock.querySelector<HTMLElement>("[data-coding-coordination-primary]");
  if (primaryNode && primary) {
    primaryNode.textContent = `${primary.identity.runtime} · ${primary.identity.model}`;
  }

  if (entries.length === 0) return;
  const persistentPrimary = primaryNode?.textContent?.trim().split(" · ") ?? [];
  const list = document.createElement("ol");
  list.setAttribute("aria-label", "Collaboration plan ordered by task dependencies");
  let previousStage: number | undefined;
  for (const entry of entries) {
    if (entry.stage !== previousStage) {
      const stage = document.createElement("li");
      stage.className = "coding-coordination-stage";
      stage.dataset.stage = String(entry.stage + 1);
      const name = document.createElement("span");
      name.textContent = `Step ${entry.stage + 1}`;
      const stageSize = entries.filter((candidate) => candidate.stage === entry.stage).length;
      const detail = document.createElement("small");
      detail.textContent = entry.stage === 0
        ? stageSize > 1 ? `${stageSize} agents start in parallel` : "Starting work"
        : stageSize > 1 ? `${stageSize} agents after accepted handoffs` : "After accepted handoff";
      stage.append(name, detail);
      list.append(stage);
      previousStage = entry.stage;
    }
    const usesPrimaryCodingAgent = entry.task
      ? ["implement", "remediate", "mutate", "propose"].some((capability) =>
          entry.task!.capability.toLowerCase().includes(capability))
      : false;
    const runtime = entry.identity.runtime === "Agent binding pending" && usesPrimaryCodingAgent
      ? persistentPrimary[0] || entry.identity.runtime
      : entry.identity.runtime;
    const model = entry.identity.model === "Model pending" && usesPrimaryCodingAgent
      ? persistentPrimary.slice(1).join(" · ") || entry.identity.model
      : entry.identity.model;
    const item = document.createElement("li");
    item.dataset.state = entry.state;
    item.dataset.nodeId = entry.node.nodeId;

    const person = document.createElement("div");
    person.className = "coding-coordination-person";
    const avatar = document.createElement("span");
    avatar.className = "coding-coordination-live-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = (entry.node.name.trim()[0] || "A").toUpperCase();
    const personCopy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = entry.node.name.split(",", 1)[0] || entry.node.name;
    const role = document.createElement("small");
    role.textContent = nodeRole(entry.node);
    const placement = document.createElement("span");
    placement.className = "coding-coordination-execution";
    placement.dataset.codingAgent = runtime;
    placement.dataset.codingModel = model;
    for (const [label, value] of [["Agent", runtime], ["Model", model]].filter(([, value]) =>
      value !== "Agent binding pending" && value !== "Model pending")) {
      const field = document.createElement("span");
      const term = document.createElement("b");
      term.textContent = label;
      field.append(term, ` ${value}`);
      placement.append(field);
    }
    personCopy.append(name, role);
    if (placement.childElementCount > 0) personCopy.append(placement);
    person.append(avatar, personCopy);

    const state = document.createElement("span");
    state.className = "coding-coordination-state";
    const stateMarker = document.createElement("i");
    stateMarker.setAttribute("aria-hidden", "true");
    state.append(stateMarker, entry.state === "done"
      ? "Complete"
      : entry.state === "blocked"
        ? "Needs attention"
        : entry.state[0]!.toUpperCase() + entry.state.slice(1));

    const task = document.createElement("p");
    const milestone = entry.task ? capabilityLabel(entry.task.capability) : "Assigned work";
    task.textContent = entry.task
      ? entry.state === "blocked"
        ? `${milestone} stopped`
        : entry.state === "working"
          ? `${milestone} in progress`
          : entry.state === "done"
            ? `${milestone} contribution accepted`
            : `${milestone} queued`
      : "Waiting for task assignment";

    const ownership = document.createElement("span");
    ownership.className = "coding-coordination-handoff";
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↳";
    ownership.append(arrow, entry.state === "done"
      ? "Contribution accepted"
      : entry.state === "working"
        ? "Owns this task now"
        : "Ready when its inputs are accepted");

    const inspect = document.createElement("a");
    inspect.href = `#coding-cast-${encodeURIComponent(entry.node.nodeId)}`;
    inspect.dataset.coordinationSelectNode = entry.node.nodeId;
    inspect.dataset.focusKey = `coordination-${entry.node.nodeId}`;
    inspect.setAttribute("aria-label", `View ${entry.node.name} details`);
    inspect.append("View details ", Object.assign(document.createElement("span"), {
      textContent: "→",
    }));

    item.append(person, state, task);
    item.append(ownership, inspect);
    list.append(item);
  }
  const renderKey = entries.map((entry) => [
    entry.node.nodeId,
    entry.node.updatedAt.microsSinceUnixEpoch.toString(),
    entry.state,
    entry.stage,
    entry.task?.taskId ?? "",
    entry.task?.status ?? "",
    entry.identity.runtime,
    entry.identity.model,
  ].join(":")).join("|");
  if (body.dataset.renderKey !== renderKey) {
    body.dataset.renderKey = renderKey;
    body.replaceChildren(list);
  }
};

const renderCast = (): void => {
  const list = document.querySelector<HTMLUListElement>("[data-realtime-cast]");
  if (!list) return;
  const selectedNodes = [...nodes.values()]
    .filter((node) => node.roomId === roomId && (!activeRunId || !node.runId || node.runId === activeRunId))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (selectedNodes.length === 0) return;
  const fragment = document.createDocumentFragment();
  const renderKey: string[] = [];
  for (const node of selectedNodes) {
    const presentation = codingNodePresentation(
      [...tasks.values()].filter((candidate) =>
        candidate.runId === activeRunId && candidate.nodeId === node.nodeId),
      activeRunPresentation(),
    );
    const task = presentation.task as TaskRow | undefined;
    const binding = [...bindings.values()]
      .filter((candidate) => candidate.roomId === roomId && candidate.nodeId === node.nodeId)
      .sort((left, right) => left.epoch > right.epoch ? -1 : 1)[0];
    const identity = nodeRuntimeIdentity(node, binding);
    renderKey.push([
      node.nodeId,
      node.name,
      node.updatedAt.microsSinceUnixEpoch.toString(),
      presentation.state,
      task?.taskId ?? "",
      task?.status ?? "",
      binding?.id ?? "",
      binding?.epoch.toString() ?? "",
      identity.runtime,
      identity.model,
    ].join(":"));
    const item = document.createElement("li");
    item.id = `coding-cast-${encodeURIComponent(node.nodeId)}`;
    item.dataset.slot = "cast-member";
    item.dataset.state = presentation.state;
    item.dataset.nodeId = node.nodeId;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.selectAgent = node.nodeId;
    button.dataset.focusKey = `cast-${node.nodeId}`;
    button.setAttribute("aria-expanded", "false");
    const name = document.createElement("strong");
    name.textContent = node.name;
    const role = document.createElement("span");
    role.textContent = nodeRole(node);
    const execution = document.createElement("em");
    execution.dataset.slot = "cast-member-execution";
    execution.dataset.codingAgent = identity.runtime;
    execution.dataset.codingModel = identity.model;
    execution.textContent = `Agent: ${identity.runtime} · Model: ${identity.model}`;
    const hasRuntime = identity.runtime !== "Agent binding pending";
    const hasModel = identity.model !== "Model pending";
    const state = document.createElement("small");
    state.textContent = presentation.state === "done"
      ? "Complete"
      : presentation.state === "blocked"
        ? "Needs attention"
        : presentation.state[0]!.toUpperCase() + presentation.state.slice(1);
    button.append(name, role);
    if (hasRuntime || hasModel) {
      execution.textContent = [
        hasRuntime ? `Agent: ${identity.runtime}` : "",
        hasModel ? `Model: ${identity.model}` : "",
      ].filter(Boolean).join(" · ");
      button.append(execution);
    }
    button.append(state);
    const details = document.createElement("div");
    details.dataset.slot = "cast-member-technical";
    details.hidden = true;
    const technical = [
      ...(hasRuntime ? [["Agent", identity.runtime]] : []),
      ...(hasModel ? [["Model", identity.model]] : []),
      ["Binding epoch", binding?.epoch.toString() ?? "unbound"],
    ];
    const definition = document.createElement("dl");
    for (const [term, description] of technical) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = description;
      row.append(dt, dd);
      definition.append(row);
    }
    details.append(definition);
    item.append(button, details);
    fragment.append(item);
  }
  const nextRenderKey = renderKey.join("|");
  if (list.dataset.renderKey !== nextRenderKey) {
    list.dataset.renderKey = nextRenderKey;
    list.replaceChildren(fragment);
  }
};

const renderExecution = (): void => {
  const room = rooms.get(roomId);
  if (room?.activeRunId && room.activeRunId !== activeRunId) {
    activeRunId = room.activeRunId;
    shutdownRuntimeLogStream();
    shutdownRoomUpdateStream("replaced");
    roomUpdates.clear();
    renderedRoomUpdateRows = [];
    runtimeLogs.clear();
    runtimeLogCursor = 0;
    runtimeLogLastSignalAt = 0;
    queueMicrotask(() => {
      if (!disposed) connect();
    });
  }
  if (!activeRunId) {
    return;
  }
  const presentation = activeRunPresentation();
  if (!shouldOpenCodingRoomStream(boot.job?.status, activeExecution()?.status)) {
    shutdownRoomUpdateStream("terminal");
  }
  const deliveryDisposition = activeDeliveryDisposition();
  const progressRow = document.querySelector<HTMLElement>("[data-coding-run-progress]");
  if (progressRow) {
    progressRow.dataset.state = presentation.state === "complete"
      ? "completed"
      : presentation.needsAttention
        ? "failed"
        : presentation.state === "working"
          ? "working"
          : "waiting";
    replaceText("[data-coding-progress-label]", presentation.label);
    replaceText("[data-coding-progress-message]", presentation.summary);
    replaceText("[data-coding-progress-summary]", presentation.progress);
    const latestActivityAt = latestActiveRunActivityAt();
    if (latestActivityAt > 0) progressRow.dataset.lastActivityAt = String(latestActivityAt);
    const article = progressRow.querySelector<HTMLElement>("article");
    if (article && presentation.needsAttention && !certifiedDeliveryNeedsAttention()) {
      let recovery = article.querySelector<HTMLElement>(".coding-run-recovery-copy");
      if (!recovery) {
        recovery = document.createElement("p");
        recovery.className = "coding-run-recovery-copy";
        recovery.dataset.realtimeRecovery = "true";
        article.append(recovery);
      }
      recovery.textContent = "@You, choose Retry Run to start a fresh bounded attempt, or reply here with a narrower next step. Accepted contributions stay preserved.";
      if (!article.querySelector(".coding-retry-action")) {
        const jobId = new URL(location.href).searchParams.get("job");
        if (jobId) {
          const form = document.createElement("form");
          form.className = "coding-retry-action coding-retry-action-compact";
          form.action = `/coding/runs/${encodeURIComponent(activeRunId)}/retry`;
          form.method = "post";
          form.dataset.realtimeRecovery = "true";
          const job = document.createElement("input");
          job.type = "hidden";
          job.name = "jobId";
          job.value = jobId;
          const submit = document.createElement("button");
          submit.type = "submit";
          submit.textContent = "Retry Run";
          form.append(job, submit);
          article.append(form);
        }
      }
    } else if (article) {
      for (const recovery of article.querySelectorAll<HTMLElement>("[data-realtime-recovery]")) recovery.remove();
    }
    if (deliveryDisposition) {
      for (const actions of article?.querySelectorAll<HTMLElement>(".coding-run-delivery-actions") ?? []) actions.remove();
    }
  }
  if (deliveryDisposition) {
    const attentionItem = document.querySelector<HTMLElement>(
      `[data-coding-attention-job="${CSS.escape(deliveryDisposition.jobId)}"]`,
    );
    if (attentionItem) {
      attentionItem.remove();
      const count = document.querySelector<HTMLElement>("[data-attention-count]");
      const current = Number.parseInt(count?.textContent ?? "", 10);
      if (count && Number.isFinite(current)) count.textContent = String(Math.max(0, current - 1));
    }
    const roomRow = document.querySelector<HTMLElement>(
      `[data-coding-room-job="${CSS.escape(deliveryDisposition.jobId)}"] [data-coding-room-activity]`,
    );
    if (roomRow) roomRow.textContent = "Closed · branch kept · now";
  }
  for (const status of document.querySelectorAll<HTMLElement>("[data-run-presentation]")) {
    status.dataset.state = presentation.state;
  }
  replaceAllText("[data-run-presentation-label]", presentation.label);
  replaceAllText("[data-run-presentation-summary]", presentation.summary);
  replaceAllText("[data-run-presentation-progress]", presentation.progress);
  const executionSummary = document.querySelector<HTMLElement>("[data-execution-summary]");
  if (executionSummary) {
    executionSummary.dataset.state = presentation.state;
    if (executionSummary.textContent !== presentation.label) executionSummary.textContent = presentation.label;
  }
  const roomHeader = document.querySelector<HTMLElement>("[data-slot='room-header']");
  if (roomHeader) {
    roomHeader.dataset.runState = presentation.state;
  }
  const currentHistory = document.querySelector<HTMLElement>(".coding-history-list [aria-current='page']");
  if (currentHistory) {
    currentHistory.dataset.state = presentation.state === "complete"
      ? "success"
      : presentation.state === "needs-attention" || presentation.state === "stopped"
        ? "failed"
        : presentation.state === "preparing"
          ? "idle"
          : "active";
    replaceText(".coding-history-list [aria-current='page'] [data-run-list-status]", presentation.label);
  }
  const composerPresence = document.querySelector<HTMLElement>("[data-run-presence]");
  if (composerPresence) {
    composerPresence.dataset.state = presentation.state === "needs-attention" || presentation.state === "stopped"
      ? "blocked"
      : presentation.state === "working"
        ? "working"
        : "ready";
    replaceText("[data-run-presence-name]", presentation.state === "working"
      ? [...nodes.values()].find((node) =>
          [...tasks.values()].some((task) =>
            task.runId === activeRunId
            && task.nodeId === node.nodeId
            && (task.status === "running" || task.status === "leased")))?.name.split(",", 1)[0] ?? "Team"
      : "Team");
    replaceText("[data-run-presence-status]", `· ${presentation.label}`);
  }
  const collaborationSummary = collaborationSummaries.get(activeRunId);
  if (collaborationSummary) {
    replaceText("[data-coding-proposal-count]", String(collaborationSummary.proposalCount));
    replaceText("[data-coding-response-count]", String(collaborationSummary.responseCount));
    replaceText("[data-coding-endorsement-count]", String(collaborationSummary.endorsementCount));
  } else {
    const outputKeys = new Set([...outputReferences.values()]
      .filter((row) => row.runId === activeRunId)
      .map((row) => row.outputKey));
    for (const row of timeline.values()) {
      if (row.runId !== activeRunId || row.kind !== "artifact") continue;
      const entry = parseJsonRecord(row.entryJson);
      if (!Array.isArray(entry.outputKeys)) continue;
      for (const outputKey of entry.outputKeys) {
        if (typeof outputKey === "string") outputKeys.add(outputKey);
      }
    }
    // Raw artifact references are deliberately hidden from viewer
    // capabilities. Timeline metadata keeps new runs live while the summary
    // view provides exact historical counts.
    if (outputKeys.size > 0) {
      replaceText(
        "[data-coding-proposal-count]",
        String([...outputKeys].filter((key) => key.startsWith("collaboration_proposal_")).length),
      );
      replaceText(
        "[data-coding-response-count]",
        String([...outputKeys].filter((key) => key.startsWith("collaboration_response_")).length),
      );
      replaceText(
        "[data-coding-endorsement-count]",
        String([...outputKeys].filter((key) => key.startsWith("collaboration_endorsement_")).length),
      );
    }
  }
};

const renderRuntimeLogs = (): void => {
  for (const terminal of document.querySelectorAll<HTMLElement>("[data-coding-agent-terminal][data-node-id]")) {
    const nodeId = terminal.dataset.nodeId;
    if (!nodeId) continue;
    const entries = [...runtimeLogs.values()]
      .filter((entry) => entry.runId === activeRunId && entry.nodeId === nodeId)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-120);
    const telemetryByRawLogRef = new Map(codingRuntimeTelemetry(entries).map((entry) => [entry.rawLogRef, entry]));
    const live = [...tasks.values()].some((task) =>
      task.runId === activeRunId
      && task.nodeId === nodeId
      && (task.status === "running" || task.status === "leased"));
    const status = terminal.querySelector<HTMLElement>("header span");
    if (status) {
      const label = live && runtimeLogState === "paused"
        ? "Updates paused"
        : live
          ? "Live"
          : entries.length > 0
            ? "Retained"
            : "Waiting";
      status.textContent = `${label} · ${entries.length}`;
    }
    terminal.dataset.entryCount = String(entries.length);
    terminal.dataset.streamState = runtimeLogState;
    const list = terminal.querySelector<HTMLOListElement>("ol");
    if (!list) continue;
    const followEnd = list.scrollHeight - list.clientHeight - list.scrollTop < 32;
    const renderKey = `${runtimeLogState}:${live}:${entries.length}:${entries.at(-1)?.sequence ?? 0}`;
    if (list.dataset.renderKey === renderKey) continue;
    list.dataset.renderKey = renderKey;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement("li");
      item.dataset.stream = entry.stream;
      const rawLogRef = `runtime-log:${entry.runId}:${entry.sequence}`;
      const telemetry = telemetryByRawLogRef.get(rawLogRef);
      if (telemetry) {
        item.dataset.commandKind = telemetry.commandKind;
        item.dataset.rawLogRef = telemetry.rawLogRef;
        item.dataset.taskId = telemetry.taskId;
        item.dataset.nodeId = telemetry.nodeId;
        item.dataset.at = String(telemetry.at);
      }
      const metadata = document.createElement("span");
      const time = document.createElement("time");
      time.dateTime = new Date(entry.at).toISOString();
      time.textContent = new Date(entry.at).toLocaleTimeString("en-US", { hour12: false });
      const sequence = document.createElement("code");
      sequence.textContent = String(entry.sequence).padStart(3, "0");
      metadata.append(time, sequence);
      const output = document.createElement("pre");
      output.textContent = `${entry.text}${entry.truncated ? "\n… output chunk truncated" : ""}`;
      item.append(metadata, output);
      fragment.append(item);
    }
    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "coding-agent-terminal-empty";
      empty.textContent = live
        ? runtimeLogState === "paused"
          ? "Live output is temporarily unavailable; durable task updates continue above."
          : "Waiting for the agent process to emit output…"
        : "No ephemeral process output is retained for this agent.";
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    if (followEnd) list.scrollTop = list.scrollHeight;
    const countLabel = document.querySelector<HTMLElement>(
      `[data-coding-agent-row][data-node-id="${CSS.escape(nodeId)}"] [data-runtime-log-label]`,
    );
    if (countLabel) countLabel.textContent = `${entries.length ? `${entries.length} · ` : ""}Logs ›`;
  }
  renderConversationLiveActivity();
};

const scheduleRuntimeLogRender = (): void => {
  if (disposed || runtimeLogRenderFrame) return;
  runtimeLogRenderFrame = window.requestAnimationFrame(() => {
    runtimeLogRenderFrame = 0;
    const snapshot = takeUiSnapshot();
    renderRuntimeLogs();
    restoreUiSnapshot(snapshot);
  });
};

const announceRuntimeSignal = (at: number): void => {
  runtimeLogLastSignalAt = Math.max(runtimeLogLastSignalAt, at);
  const progress = document.querySelector<HTMLElement>("[data-coding-run-progress]");
  if (progress) progress.dataset.runtimeSignalAt = String(runtimeLogLastSignalAt);
  document.dispatchEvent(new CustomEvent("coding:runtime-heartbeat", {
    detail: { runId: activeRunId, at: runtimeLogLastSignalAt },
  }));
};

const scheduleRuntimeLogReconnect = (): void => {
  if (disposed || runtimeLogReconnectTimer || !activeRunId) return;
  runtimeLogReconnectTimer = window.setTimeout(() => {
    runtimeLogReconnectTimer = 0;
    connectRuntimeLogs();
  }, 1_000);
};

const cancelStreamReader = (reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void => {
  if (!reader) return;
  void reader.cancel()
    .catch(() => undefined)
    .then(() => {
      try {
        reader.releaseLock();
      } catch {
        // The stream consumer may already have released this reader.
      }
    });
};

const shutdownRuntimeLogStream = (): void => {
  const active = Boolean(runtimeLogController || runtimeLogReader || runtimeLogReconnectTimer);
  if (!active) return;
  runtimeLogGeneration += 1;
  window.clearTimeout(runtimeLogReconnectTimer);
  runtimeLogReconnectTimer = 0;
  const controller = runtimeLogController;
  runtimeLogController = undefined;
  controller?.abort();
  const reader = runtimeLogReader;
  runtimeLogReader = undefined;
  cancelStreamReader(reader);
  runtimeLogState = "paused";
};

const connectRuntimeLogs = (): void => {
  const params = new URL(location.href).searchParams;
  const conversationId = params.get("run") ?? "";
  const jobId = params.get("job") ?? "";
  if (disposed || !activeRunId || !conversationId || !jobId || !repositoryWorkspaceId) return;
  shutdownRuntimeLogStream();
  const controller = new AbortController();
  runtimeLogController = controller;
  const streamGeneration = ++runtimeLogGeneration;
  const isCurrentRuntimeLogStream = (): boolean => !disposed
    && !controller.signal.aborted
    && streamGeneration === runtimeLogGeneration
    && runtimeLogController === controller;
  runtimeLogState = "connecting";
  renderRuntimeLogs();
  const endpoint = new URL("/coding/runtime-logs", location.origin);
  endpoint.searchParams.set("run", activeRunId);
  endpoint.searchParams.set("conversation", conversationId);
  endpoint.searchParams.set("job", jobId);
  endpoint.searchParams.set("workspace", repositoryWorkspaceId);
  endpoint.searchParams.set("after", String(runtimeLogCursor));
  const consume = async (): Promise<void> => {
    const guardedResponse = await awaitCurrentCodingStreamResponse(fetch(endpoint, {
      headers: { Accept: "application/x-ndjson" },
      signal: controller.signal,
    }), isCurrentRuntimeLogStream);
    const response = acceptCurrentCodingStreamResponse(guardedResponse, isCurrentRuntimeLogStream);
    if (!response) return;
    if (!response.ok || !response.body) throw new Error(`Runtime log stream failed with ${response.status}`);
    runtimeLogState = "live";
    announceRuntimeSignal(Date.now());
    renderRuntimeLogs();
    const reader = response.body.getReader();
    runtimeLogReader = reader;
    const decoder = new BoundedNdjsonLineDecoder();
    const applyLine = (line: string): void => {
      if (!line.trim()) return;
      const message = parseJsonRecord(line);
      if (message.type === "heartbeat" && typeof message.at === "number" && Number.isFinite(message.at)) {
        announceRuntimeSignal(message.at);
        return;
      }
      const entry = record(message.entry);
      if (message.type !== "log" || !entry
        || entry.runId !== activeRunId
        || typeof entry.nodeId !== "string"
        || typeof entry.taskId !== "string"
        || typeof entry.runtime !== "string"
        || (entry.stream !== "stdout" && entry.stream !== "stderr")
        || typeof entry.text !== "string"
        || typeof entry.sequence !== "number"
        || !Number.isSafeInteger(entry.sequence)
        || entry.sequence < 1
        || typeof entry.at !== "number"
        || typeof entry.truncated !== "boolean") return;
      const runtimeEntry = entry as RuntimeLogRow;
      announceRuntimeSignal(Date.now());
      runtimeLogCursor = Math.max(runtimeLogCursor, runtimeEntry.sequence);
      runtimeLogs.set(runtimeEntry.sequence, runtimeEntry);
      scheduleRuntimeLogRender();
    };
    try {
      while (isCurrentRuntimeLogStream()) {
        const guardedChunk = await readCurrentCodingStreamChunk(reader, isCurrentRuntimeLogStream);
        const chunk = acceptCurrentCodingStreamChunk(guardedChunk, reader, isCurrentRuntimeLogStream);
        if (!chunk) return;
        if (chunk.done) break;
        decoder.push(chunk.value, applyLine);
      }
      if (!isCurrentRuntimeLogStream()) return;
      decoder.finish(applyLine);
      if (!controller.signal.aborted) throw new Error("Runtime log stream closed");
    } finally {
      if (runtimeLogReader === reader) runtimeLogReader = undefined;
      try {
        reader.releaseLock();
      } catch {
        // A canceled reader may already have released its lock.
      }
    }
  };
  consume().catch(() => {
    if (disposed || controller.signal.aborted || streamGeneration !== runtimeLogGeneration) return;
    runtimeLogState = "paused";
    renderRuntimeLogs();
    scheduleRuntimeLogReconnect();
  }).finally(() => {
    if (runtimeLogController === controller) runtimeLogController = undefined;
  });
};

const markRoomUpdateLabelsPaused = (): void => {
  for (const article of document.querySelectorAll<HTMLElement>(
    '[data-coding-social-row][data-source-kind="live-update"]',
  )) {
    if (article.dataset.updateSettled === "true") continue;
    article.dataset.roomConnection = "paused";
    const label = article.querySelector<HTMLElement>(".coding-live-label");
    if (label) label.replaceChildren("Paused");
  }
};

const applyRoomUpdateStreamRecord = (line: string): boolean => {
  if (!line.trim()) return false;
  const message = parseJsonRecord(line);
  if (message.type === "heartbeat") {
    if (!exactFields(message, ROOM_UPDATE_HEARTBEAT_FIELDS)
      || typeof message.at !== "number"
      || !Number.isFinite(message.at)) return false;
    return true;
  }
  if (message.type === "snapshot") {
    if (!exactFields(message, ROOM_UPDATE_SNAPSHOT_FIELDS)
      || !Array.isArray(message.updates)
      || message.updates.length > ROOM_UPDATE_SNAPSHOT_LIMIT) return false;
    const staged: NodeRoomUpdate[] = [];
    for (const value of message.updates) {
      const update = parsePublicRoomUpdate(value);
      if (!update) return false;
      staged.push(update);
    }
    if (roomUpdates.applyInitialSnapshot(staged)) scheduleRoomUpdateRender();
    return true;
  }
  if (message.type === "update" || message.type === "settled") {
    if (!exactFields(message, ROOM_UPDATE_RECORD_FIELDS)) return false;
    const update = parsePublicRoomUpdate(message.update);
    if (!update || (message.type === "settled" && !update.settled)) return false;
    roomUpdates.apply(update);
    scheduleRoomUpdateRender();
    return true;
  }
  return false;
};

type RoomUpdateShutdownReason = "disposed" | "paused" | "replaced" | "terminal";

const shutdownRoomUpdateStream = (reason: RoomUpdateShutdownReason): void => {
  roomUpdateReconnectBackoff.transition(reason);
  if (reason !== "paused") roomUpdateReconnectIdentity = "";
  const active = Boolean(roomUpdateController
    || roomUpdateReader
    || roomUpdateReconnectTimer
    || roomUpdateStreamIdentity
    || roomUpdateState === "live");
  if (!active) return;
  roomUpdateGeneration += 1;
  window.clearTimeout(roomUpdateReconnectTimer);
  roomUpdateReconnectTimer = 0;
  const controller = roomUpdateController;
  roomUpdateController = undefined;
  controller?.abort();
  const reader = roomUpdateReader;
  roomUpdateReader = undefined;
  cancelStreamReader(reader);
  roomUpdateStreamIdentity = "";
  roomUpdateState = "paused";
  if (reason === "paused") markRoomUpdateLabelsPaused();
};

const scheduleRoomUpdateReconnect = (): void => {
  if (disposed
    || roomUpdateReconnectTimer
    || roomUpdateController
    || !activeRunId
    || !shouldOpenCodingRoomStream(boot.job?.status, activeExecution()?.status)) return;
  const retry = roomUpdateReconnectBackoff.nextRetry();
  roomUpdateReconnectTimer = window.setTimeout(() => {
    roomUpdateReconnectTimer = 0;
    connectRoomUpdates();
  }, retry.delayMs);
};

const connectRoomUpdates = (): void => {
  const conversationId = boot.conversationId ?? new URL(location.href).searchParams.get("run") ?? "";
  const jobId = boot.job?.id ?? new URL(location.href).searchParams.get("job") ?? "";
  const identity = [activeRunId, conversationId, jobId, boot.workspaceId].join("\u0000");
  if (disposed
    || !activeRunId
    || !conversationId
    || !jobId
    || !boot.workspaceId
    || !shouldOpenCodingRoomStream(boot.job?.status, activeExecution()?.status)) {
    shutdownRoomUpdateStream("terminal");
    return;
  }
  if (roomUpdateController && roomUpdateStreamIdentity === identity) return;
  if (roomUpdateReconnectIdentity !== identity) shutdownRoomUpdateStream("replaced");
  else if (roomUpdateController || roomUpdateReader || roomUpdateReconnectTimer || roomUpdateStreamIdentity) {
    shutdownRoomUpdateStream("paused");
  }
  roomUpdateReconnectIdentity = identity;
  const controller = new AbortController();
  roomUpdateController = controller;
  roomUpdateStreamIdentity = identity;
  const streamGeneration = ++roomUpdateGeneration;
  const isCurrentRoomUpdateStream = (): boolean => !disposed
    && !controller.signal.aborted
    && streamGeneration === roomUpdateGeneration
    && roomUpdateController === controller;
  roomUpdates.beginStreamGeneration();
  const endpoint = new URL("/coding/room-updates", location.origin);
  endpoint.searchParams.set("run", activeRunId);
  endpoint.searchParams.set("conversation", conversationId);
  endpoint.searchParams.set("job", jobId);
  endpoint.searchParams.set("workspace", boot.workspaceId);
  const consume = async (): Promise<void> => {
    const guardedResponse = await awaitCurrentCodingStreamResponse(fetch(endpoint, {
      headers: { Accept: "application/x-ndjson" },
      signal: controller.signal,
    }), isCurrentRoomUpdateStream);
    const response = acceptCurrentCodingStreamResponse(guardedResponse, isCurrentRoomUpdateStream);
    if (!response) return;
    let admissionError: Error | undefined;
    if (!routeCodingRoomStreamAdmission(
      { status: response.status, ok: response.ok, hasBody: Boolean(response.body) },
      {
        onTerminal: () => shutdownRoomUpdateStream("terminal"),
        onRetry: () => { admissionError = new Error(`Room update stream failed with ${response.status}`); },
      },
    )) {
      if (admissionError) throw admissionError;
      return;
    }
    if (!response.body) return;
    roomUpdateState = "live";
    roomUpdateReconnectBackoff.transition("connected");
    scheduleRoomUpdateRender();
    const reader = response.body.getReader();
    roomUpdateReader = reader;
    const decoder = new BoundedNdjsonLineDecoder();
    const applyLine = (line: string): void => {
      if (applyRoomUpdateStreamRecord(line)) roomUpdateReconnectBackoff.transition("record");
    };
    try {
      while (isCurrentRoomUpdateStream()) {
        const guardedChunk = await readCurrentCodingStreamChunk(reader, isCurrentRoomUpdateStream);
        const chunk = acceptCurrentCodingStreamChunk(guardedChunk, reader, isCurrentRoomUpdateStream);
        if (!chunk) return;
        if (chunk.done) break;
        decoder.push(chunk.value, applyLine);
      }
      if (!isCurrentRoomUpdateStream()) return;
      decoder.finish(applyLine);
      if (!controller.signal.aborted) {
        const transition = codingRoomStreamEofTransition(
          boot.job?.status,
          activeExecution()?.status,
        );
        shutdownRoomUpdateStream(transition);
        if (transition === "paused") scheduleRoomUpdateReconnect();
      }
    } finally {
      if (roomUpdateReader === reader) roomUpdateReader = undefined;
      try {
        reader.releaseLock();
      } catch {
        // A canceled reader may already have released its lock.
      }
    }
  };
  consume().catch(() => {
    if (disposed || controller.signal.aborted || streamGeneration !== roomUpdateGeneration) return;
    shutdownRoomUpdateStream("paused");
    scheduleRoomUpdateReconnect();
  });
};

const hydrateInitialRoomUpdates = (): void => {
  if (!roomUpdatesModelText) return;
  const model = parseJsonRecord(roomUpdatesModelText);
  if (Object.keys(model).length !== 1 || !Array.isArray(model.updates)
    || model.updates.length > ROOM_UPDATE_SNAPSHOT_LIMIT) return;
  const staged: NodeRoomUpdate[] = [];
  for (const value of model.updates) {
    const update = parsePublicRoomUpdate(value);
    if (!update) return;
    staged.push(update);
  }
  for (const update of staged) roomUpdates.apply(update);
};

const render = (): void => {
  if (renderFrame) {
    window.cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (runtimeLogRenderFrame) {
    window.cancelAnimationFrame(runtimeLogRenderFrame);
    runtimeLogRenderFrame = 0;
  }
  const snapshot = takeUiSnapshot();
  for (const profile of participantProfiles.values()) updateParticipantProfileTriggers(profile);
  updateParticipantExecutionTriggers();
  const activeProfileNodeId = participantProfileDialog?.dataset.activeNodeId;
  if (participantProfileDialog?.open && activeProfileNodeId) syncParticipantProfileDialog(activeProfileNodeId);
  renderRealtimeConversationMessages();
  for (const profile of participantProfiles.values()) updateParticipantProfileTriggers(profile);
  updateParticipantExecutionTriggers();
  renderTimeline();
  renderFrontier();
  renderCoordination();
  renderCast();
  renderExecution();
  renderRuntimeLogs();
  normalizeResolutionReviewerLabels();
  restoreUiSnapshot(snapshot);
  renderRoomUpdates();
  document.dispatchEvent(new CustomEvent("coding:realtime-applied", {
    detail: { roomId, activeRunId },
  }));
};

const scheduleRender = (): void => {
  if (!applied || disposed || renderFrame) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
};

const installTableCallbacks = (db: CodingDatabase, callbackGeneration: number): void => {
  const current = (): boolean => callbackGeneration === generation && !disposed;
  const rowKey = (row: { readonly id?: string; readonly runId?: string }): string =>
    row.id ?? row.runId ?? "";
  const observe = <Row extends { readonly id?: string; readonly runId?: string }>(
    table: RowTable<Row>,
    target: Map<string, Row>,
  ): void => {
    table.onInsert((_context, row) => {
      if (!current()) return;
      target.set(rowKey(row), row);
      scheduleRender();
    });
    table.onUpdate((_context, previous, row) => {
      if (!current()) return;
      target.delete(rowKey(previous));
      target.set(rowKey(row), row);
      scheduleRender();
    });
    table.onDelete((_context, row) => {
      if (!current()) return;
      target.delete(rowKey(row));
      scheduleRender();
    });
  };
  // Row callbacks are intentionally installed before subscribe().
  observe(db.myCodingRoomsWindow, rooms);
  observe(db.myCodingRoomNodesWindow, nodes);
  observe(db.myCodingParticipantProfilesWindow, participantProfiles);
  observe(db.myCodingRoomTimelineWindow, timeline);
  db.myCodingRoomTimelinePage.onInsert((_context, row) => {
    if (!current()) return;
    timeline.set(row.id, row);
    scheduleRender();
  });
  db.myCodingRoomTimelinePage.onUpdate((_context, _previous, row) => {
    if (!current()) return;
    timeline.set(row.id, row);
    scheduleRender();
  });
  // Page turnover removes the server-side cursor window, not the immutable
  // history rows already deduplicated into this selected room.
  db.myCodingRoomTimelinePage.onDelete(() => {});
  observe(db.myCodingControlIntentDeliveriesWindow, intents);
  observe(db.myCodingContextFrontiersWindow, frontiers);
  observe(db.myCodingExecutionSummariesWindow, executions);
  observe(db.myCodingRunTasksWindow, tasks);
  observe(db.myCodingRunTaskEdgesWindow, taskEdges);
  observe(db.myCodingRunTaskOutputReferencesWindow, outputReferences);
  observe(db.myCodingCollaborationSummariesWindow, collaborationSummaries);
  observe(db.myCodingActiveRuntimeBindingsWindow, bindings);
};

const hydrate = (db: CodingDatabase): void => {
  const replace = <Row extends { readonly id?: string; readonly runId?: string }>(
    table: RowTable<Row>,
    target: Map<string, Row>,
  ): void => {
    target.clear();
    for (const row of table.iter()) target.set(row.id ?? row.runId ?? "", row);
  };
  replace(db.myCodingRoomsWindow, rooms);
  replace(db.myCodingRoomNodesWindow, nodes);
  replace(db.myCodingParticipantProfilesWindow, participantProfiles);
  replace(db.myCodingRoomTimelineWindow, timeline);
  replace(db.myCodingControlIntentDeliveriesWindow, intents);
  replace(db.myCodingContextFrontiersWindow, frontiers);
  replace(db.myCodingExecutionSummariesWindow, executions);
  replace(db.myCodingRunTasksWindow, tasks);
  replace(db.myCodingRunTaskEdgesWindow, taskEdges);
  replace(db.myCodingRunTaskOutputReferencesWindow, outputReferences);
  replace(db.myCodingCollaborationSummariesWindow, collaborationSummaries);
  replace(db.myCodingActiveRuntimeBindingsWindow, bindings);
};

const selectedQueries = (): ReadonlyArray<string> => {
  const room = sqlLiteral(roomId);
  const run = sqlLiteral(activeRunId || "__no_active_run__");
  const selection = sqlLiteral(timelineSelectionId);
  return [
    `SELECT * FROM my_coding_rooms_window WHERE id = ${room}`,
    `SELECT * FROM my_coding_room_nodes_window WHERE room_id = ${room}`,
    `SELECT * FROM my_coding_participant_profiles_window WHERE workspace_id = ${sqlLiteral(boot.workspaceId)}`,
    `SELECT * FROM my_coding_room_timeline_window WHERE room_id = ${room} AND selection_id = ${selection}`,
    `SELECT * FROM my_coding_room_timeline_page WHERE room_id = ${room} AND selection_id = ${selection}`,
    `SELECT * FROM my_coding_control_intent_deliveries_window WHERE room_id = ${room}`,
    `SELECT * FROM my_coding_context_frontiers_window WHERE room_id = ${room}`,
    `SELECT * FROM my_coding_execution_summaries_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_run_tasks_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_run_task_edges_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_run_task_output_references_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_collaboration_summaries_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_active_runtime_bindings_window WHERE room_id = ${room}`,
  ];
};

const loadOlderTimelinePage = (button: HTMLButtonElement): void => {
  const selectedActivityCount = [...timeline.values()].filter((row) =>
    row.roomId === roomId
    && (!activeRunId || !row.runId || row.runId === activeRunId)
    && row.kind !== "message").length;
  if (selectedActivityCount > visibleTimelineRows) {
    visibleTimelineRows += TIMELINE_PAGE_SIZE;
    render();
    queueMicrotask(() => document.querySelector<HTMLElement>("[data-focus-key='timeline-load-older']")?.focus());
    return;
  }
  if (!connection || !applied) return;
  const oldest = [...timeline.values()]
    .filter((row) => row.roomId === roomId && (!activeRunId || !row.runId || row.runId === activeRunId))
    .reduce<bigint | undefined>((minimum, row) => minimum === undefined || row.seq < minimum ? row.seq : minimum, undefined);
  if (oldest === undefined || oldest <= 1n) return;
  const rangeKey = oldest.toString();
  if (timelineHistoryRanges.has(rangeKey)) return;
  timelineHistoryRanges.add(rangeKey);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const callbackGeneration = generation;
  void connection.reducers.selectCodingRoomTimelinePage({
    runId: activeRunId,
    roomId,
    beforeSeq: oldest,
    selectionId: timelineSelectionId,
    predecessorSelectionId: "",
    ttlSeconds: 3_600n,
  }).then(() => {
    if (callbackGeneration !== generation || disposed) return;
    const db = connection?.db as unknown as CodingDatabase | undefined;
    if (!db) return;
    for (const row of db.myCodingRoomTimelinePage.iter()) {
      if (row.selectionId === timelineSelectionId
        && row.runId === activeRunId && row.roomId === roomId && row.seq < oldest) {
        timeline.set(row.id, row);
      }
    }
    visibleTimelineRows += TIMELINE_PAGE_SIZE;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    render();
    queueMicrotask(() => document.querySelector<HTMLElement>("[data-focus-key='timeline-load-older']")?.focus());
  }).catch(() => {
    if (callbackGeneration !== generation || disposed) return;
    timelineHistoryRanges.delete(rangeKey);
    button.disabled = false;
    button.removeAttribute("aria-busy");
  });
};

const scheduleReconnect = (reason: string): void => {
  if (disposed || reconnectTimer) return;
  applied = false;
  reconnectAttempt += 1;
  const delay = codingRoomReconnectDelay(reconnectAttempt);
  if (hasAppliedSubscription) {
    // Keep brief network handoffs invisible when a valid room snapshot is
    // already on screen. If recovery takes longer, describe the user impact
    // instead of exposing the transport implementation as "Reconnecting".
    if (!reconnectNoticeTimer) {
      reconnectNoticeTimer = window.setTimeout(() => {
        reconnectNoticeTimer = 0;
        if (!disposed && reconnectAttempt > 0 && !applied) {
          setLiveState("paused", "Updates paused", `${reason} Roster is restoring live updates.`);
        }
      }, 5_000);
    }
  } else {
    setLiveState("reconnecting", "Connecting", `${reason} Retrying in ${Math.ceil(delay / 1_000)} seconds.`);
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, delay);
};

const connect = (): void => {
  if (disposed || !boot.realtime.enabled || !roomId || !activeRunId || !boot.job?.id) return;
  const connectionGeneration = ++generation;
  applied = false;
  window.cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  window.cancelAnimationFrame(runtimeLogRenderFrame);
  runtimeLogRenderFrame = 0;
  viewerGrantRenewal?.stop();
  viewerGrantRenewal = undefined;
  try {
    if (subscription?.isActive()) subscription.unsubscribe();
    for (const historySubscription of timelineHistorySubscriptions) {
      if (historySubscription.isActive()) historySubscription.unsubscribe();
    }
  } catch {
    // The previous generation may already be closed.
  }
  subscription = undefined;
  timelineHistorySubscriptions = [];
  timelineHistoryRanges.clear();
  visibleTimelineRows = INITIAL_TIMELINE_WINDOW;
  connection?.disconnect();
  connection = undefined;
  if (!hasAppliedSubscription) {
    setLiveState(
      reconnectAttempt ? "reconnecting" : "connecting",
      "Connecting",
      "Opening the caller-scoped Room OS channel.",
    );
  }

  connection = DbConnection.builder()
    .withUri(boot.realtime.uri)
    .withDatabaseName(boot.realtime.database)
    .withToken(identityToken())
    .withConfirmedReads(boot.realtime.confirmedReads)
    .withLightMode(true)
    .onConnect((next, _identity, token) => {
      if (connectionGeneration !== generation || disposed) {
        next.disconnect();
        return;
      }
      if (token) saveIdentityToken(token);
      const start = async (): Promise<void> => {
        const viewerGrant = await codingViewerCapability();
        await next.reducers.joinCanvasRun({
          runId: activeRunId,
          capabilityHash: await sha256Hex(viewerGrant.capabilitySecret),
        });
        await next.reducers.selectCodingRoomTimelinePage({
          runId: activeRunId,
          roomId,
          beforeSeq: 0n,
          selectionId: timelineSelectionId,
          predecessorSelectionId: "",
          ttlSeconds: 3_600n,
        });
        if (connectionGeneration !== generation || disposed) return;
        viewerGrantRenewal = createCodingViewerGrantRenewal<CodingViewerGrant>({
          now: () => Date.now(),
          setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimer: (timer) => window.clearTimeout(timer as number),
          mint: () => {
            cachedCodingViewerGrant = undefined;
            return codingViewerCapability();
          },
          redeem: async (renewedGrant) => {
            if (connectionGeneration !== generation || disposed) return;
            await next.reducers.joinCanvasRun({
              runId: activeRunId,
              capabilityHash: await sha256Hex(renewedGrant.capabilitySecret),
            });
            await next.reducers.selectCodingRoomTimelinePage({
              runId: activeRunId,
              roomId,
              beforeSeq: 0n,
              selectionId: timelineSelectionId,
              predecessorSelectionId: "",
              ttlSeconds: 3_600n,
            });
            if (connectionGeneration !== generation || disposed) {
              throw new Error("Coding room changed during viewer grant renewal");
            }
          },
          onError: (error) => {
            if (connectionGeneration !== generation || disposed) return;
            const message = error instanceof Error ? error.message : String(error);
            scheduleReconnect(message || "Room access renewal failed.");
            next.disconnect();
          },
        });
        viewerGrantRenewal.arm(viewerGrant.expiresAt, viewerGrant.renewalExpiresAt);
        const db = next.db as unknown as CodingDatabase;
        installTableCallbacks(db, connectionGeneration);
        setLiveState("syncing", "Synchronizing", "Applying the selected room and active execution.");
        subscription = next.subscriptionBuilder()
          .onApplied(() => {
            if (connectionGeneration !== generation || disposed) return;
            hydrate(db);
            hydrateInitialRoomUpdates();
            applied = true;
            hasAppliedSubscription = true;
            reconnectAttempt = 0;
            window.clearTimeout(reconnectNoticeTimer);
            reconnectNoticeTimer = 0;
            render();
            connectRuntimeLogs();
            connectRoomUpdates();
            schedulePreflightReconciliation();
            // "Live" is only shown after the selected subscription is applied.
            setLiveState("live", "Live", "Transactional Room OS deltas are active.");
          })
          .onError((error) => {
            if (connectionGeneration !== generation || disposed) return;
            scheduleReconnect(error.event?.message || "The selected room subscription closed.");
          })
          .subscribe([...selectedQueries()]);
      };
      start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SenderError) {
          setLiveState("error", "Access denied", message);
          disposeCodingClient();
        } else {
          scheduleReconnect(message || "Room synchronization failed.");
        }
        next.disconnect();
      });
    })
    .onConnectError((_context, error) => {
      if (connectionGeneration === generation) scheduleReconnect(error.message || "Connection failed.");
    })
    .onDisconnect((_context, error) => {
      if (connectionGeneration === generation) scheduleReconnect(error?.message || "Connection closed.");
    })
    .build();
};

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const participant = target?.closest<HTMLElement>("[data-participant-profile]");
  if (participant) {
    openParticipantProfile(participant);
    return;
  }
  const coordinationAgent = target?.closest<HTMLAnchorElement>("[data-coordination-select-node]");
  if (coordinationAgent) {
    const nodeId = coordinationAgent.dataset.coordinationSelectNode;
    document.dispatchEvent(new CustomEvent("coding:open-context", {
      detail: { nodeId },
    }));
    const trigger = nodeId
      ? document.querySelector<HTMLButtonElement>(`[data-select-agent="${CSS.escape(nodeId)}"]`)
      : null;
    if (trigger) {
      queueMicrotask(() => {
        trigger.scrollIntoView({ block: "center" });
        if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
      });
    }
    return;
  }
  const loadOlder = target?.closest<HTMLButtonElement>("[data-load-older-timeline]");
  if (loadOlder) {
    loadOlderTimelinePage(loadOlder);
    return;
  }
  const agent = target?.closest<HTMLButtonElement>("[data-select-agent]");
  if (agent) {
    const item = agent.closest<HTMLElement>("[data-slot='cast-member']");
    const detail = item?.querySelector<HTMLElement>("[data-slot='cast-member-technical']");
    if (!item || !detail) return;
    const expanded = agent.getAttribute("aria-expanded") === "true";
    for (const candidate of document.querySelectorAll<HTMLElement>("[data-slot='cast-member']")) {
      candidate.removeAttribute("data-selected-agent");
      candidate.querySelector<HTMLElement>("[data-slot='cast-member-technical']")!.hidden = true;
      candidate.querySelector<HTMLButtonElement>("[data-select-agent]")!.setAttribute("aria-expanded", "false");
    }
    if (!expanded) {
      item.dataset.selectedAgent = agent.dataset.selectAgent;
      detail.hidden = false;
      agent.setAttribute("aria-expanded", "true");
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const selected = document.querySelector<HTMLElement>("[data-selected-agent]");
  const trigger = selected?.querySelector<HTMLButtonElement>("[data-select-agent]");
  const detail = selected?.querySelector<HTMLElement>("[data-slot='cast-member-technical']");
  if (selected && trigger && detail) {
    detail.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    selected.removeAttribute("data-selected-agent");
    trigger.focus({ preventScroll: true });
  }
});

const disposeCodingClient = createIdempotentDisposer(() => {
  disposed = true;
  generation += 1;
  runtimeLogGeneration += 1;
  roomUpdateGeneration += 1;
  window.cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  window.cancelAnimationFrame(runtimeLogRenderFrame);
  runtimeLogRenderFrame = 0;
  window.cancelAnimationFrame(roomUpdateRenderFrame);
  roomUpdateRenderFrame = 0;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  window.clearTimeout(reconnectNoticeTimer);
  reconnectNoticeTimer = 0;
  viewerGrantRenewal?.stop();
  viewerGrantRenewal = undefined;
  window.clearTimeout(preflightReconcileTimer);
  preflightReconcileTimer = 0;
  shutdownRuntimeLogStream();
  shutdownRoomUpdateStream("disposed");
  try {
    if (subscription?.isActive()) subscription.unsubscribe();
    for (const historySubscription of timelineHistorySubscriptions) {
      if (historySubscription.isActive()) historySubscription.unsubscribe();
    }
  } catch {
    // The socket may already be closed.
  }
  subscription = undefined;
  timelineHistorySubscriptions = [];
  connection?.disconnect();
  connection = undefined;
});

window.addEventListener("beforeunload", () => {
  disposeCodingClient();
}, { once: true });

if (!boot.realtime.enabled) {
  setLiveState("disabled", "Realtime unavailable", "SpacetimeDB is unavailable for this environment.");
} else if (!roomId) {
  setLiveState("disabled", "Choose a room", "Realtime starts after a room is selected.");
} else {
  connect();
}
