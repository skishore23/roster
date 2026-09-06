import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  copyRuntimeDiagnostic,
  createSingleFlightAction,
  presentRuntimeError,
  runtimeDiagnostic,
} from "./runtime-error.js";
import { selectDiscoveredRuntimes } from "./runtime-selection.js";
import "./styles.css";

type RuntimeSession = {
  readonly repositoryPath: string;
  readonly codingUrl: string;
  readonly pid: number;
};

type SavedDesktopSetup = {
  readonly repositoryPath: string;
  readonly runtimeIds: readonly string[];
  readonly defaultRuntimeId: string;
};

type DiscoveredRuntime = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly runtimeKind: string;
  readonly executablePath?: string;
  readonly version?: string;
  readonly readiness: "ready" | "probe-failed" | "not-installed";
};

type RuntimeAccess = "read-only" | "workspace-write";

type RuntimeProfile = {
  readonly id: string;
  readonly label: string;
  readonly runtimeKind: string;
  readonly command: readonly string[];
  readonly access: RuntimeAccess;
  readonly source: "discovered";
  readonly enabled: boolean;
};

const folderButton = document.querySelector<HTMLButtonElement>("[data-select-workspace]");
const folderActionLabel = document.querySelector<HTMLElement>("[data-folder-action-label]");
const repositorySummary = document.querySelector<HTMLElement>("[data-repository-summary]");
const runtimeSummary = document.querySelector<HTMLElement>("[data-runtime-summary]");
const runtimePanel = document.querySelector<HTMLElement>("[data-runtime-panel]");
const runtimeList = document.querySelector<HTMLElement>("[data-runtime-list]");
const refreshButton = document.querySelector<HTMLButtonElement>("[data-refresh-runtimes]");
const launchButton = document.querySelector<HTMLButtonElement>("[data-launch]");
const status = document.querySelector<HTMLElement>("[data-status]");
const runtimeErrorPanel = document.querySelector<HTMLElement>("[data-runtime-error]");
const runtimeErrorSummary = document.querySelector<HTMLElement>("[data-runtime-error-summary]");
const runtimeDiagnostics = document.querySelector<HTMLDetailsElement>("[data-runtime-diagnostics]");
const runtimeErrorDetails = document.querySelector<HTMLElement>("[data-runtime-error-details]");
const retryRuntimeButton = document.querySelector<HTMLButtonElement>("[data-retry-runtime]");
const copyRuntimeErrorButton = document.querySelector<HTMLButtonElement>("[data-copy-runtime-error]");
const previewRoster = document.querySelector<HTMLElement>("[data-preview-roster]");

if (
  !folderButton
  || !folderActionLabel
  || !repositorySummary
  || !runtimeSummary
  || !runtimePanel
  || !runtimeList
  || !refreshButton
  || !launchButton
  || !status
  || !runtimeErrorPanel
  || !runtimeErrorSummary
  || !runtimeDiagnostics
  || !runtimeErrorDetails
  || !retryRuntimeButton
  || !copyRuntimeErrorButton
  || !previewRoster
) {
  throw new Error("Roster desktop onboarding controls are missing");
}

let repositoryPath: string | undefined;
let discoveredRuntimes: readonly DiscoveredRuntime[] = [];
const selectedRuntimeIds = new Set<string>();
let defaultRuntimeId: string | undefined;

let canAutoResume = false;

const errorMessage = runtimeDiagnostic;

const showRuntimeError = (error: unknown): void => {
  presentRuntimeError({
    panel: runtimeErrorPanel,
    summary: runtimeErrorSummary,
    diagnostics: runtimeDiagnostics,
    details: runtimeErrorDetails,
    status,
  }, error);
};

const shortPath = (path: string): string => {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? path;
};

const setStep = (active: "repository" | "runtimes" | "room"): void => {
  document.querySelectorAll<HTMLElement>("[data-step]").forEach((step) => {
    const name = step.dataset.step;
    step.classList.toggle("is-active", name === active);
    step.classList.toggle(
      "is-complete",
      active === "room" || (active === "runtimes" && name === "repository"),
    );
  });
};

const selectedProfiles = (): readonly RuntimeProfile[] =>
  [...discoveredRuntimes]
    .sort((left, right) =>
      Number(right.id === defaultRuntimeId) - Number(left.id === defaultRuntimeId))
    .flatMap((runtime) => {
      if (!runtime.executablePath || !selectedRuntimeIds.has(runtime.id)) return [];
      return [{
        id: runtime.id,
        label: runtime.label,
        runtimeKind: runtime.runtimeKind,
        command: [runtime.executablePath],
        access: "workspace-write",
        source: "discovered" as const,
        enabled: true,
      }];
    });

const updateLaunchState = (): void => {
  const count = selectedProfiles().length;
  const hasDefault = Boolean(defaultRuntimeId && selectedRuntimeIds.has(defaultRuntimeId));
  launchButton.disabled = !repositoryPath || count === 0 || !hasDefault;
  runtimeSummary.textContent = count === 0
    ? "Select at least one installed agent"
    : !hasDefault
      ? "Choose the default agent"
      : `${count} agent${count === 1 ? "" : "s"} approved · ${discoveredRuntimes.find((runtime) => runtime.id === defaultRuntimeId)?.label ?? "local agent"} default`;
};

const renderPreviewRoster = (): void => {
  const availableRuntimes = discoveredRuntimes
    .filter((runtime) => runtime.readiness === "ready" && runtime.executablePath)
    .slice(0, 3);
  previewRoster.replaceChildren();
  if (availableRuntimes.length === 0) {
    previewRoster.textContent = "No local runtimes detected";
    return;
  }
  for (const runtime of availableRuntimes) {
    const label = document.createElement("span");
    label.className = "preview-roster-label";
    label.textContent = runtime.label;
    previewRoster.append(label);
  }
};

const renderRuntimeCards = (): void => {
  runtimeList.replaceChildren();
  for (const runtime of discoveredRuntimes) {
    const installed = Boolean(runtime.executablePath);
    const selected = installed && selectedRuntimeIds.has(runtime.id);
    const card = document.createElement("article");
    card.className = `runtime-card${selected ? " is-selected" : ""}${installed ? "" : " is-missing"}`;

    const chooser = document.createElement("label");
    chooser.className = "runtime-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.disabled = !installed;
    checkbox.dataset.runtimeId = runtime.id;
    checkbox.setAttribute("aria-label", `Enable ${runtime.label}`);
    const identity = document.createElement("span");
    identity.className = "runtime-identity";
    const heading = document.createElement("strong");
    heading.textContent = runtime.label;
    const detail = document.createElement("span");
    detail.textContent = runtime.detail;
    identity.append(heading, detail);
    chooser.append(checkbox, identity);

    const controls = document.createElement("div");
    controls.className = "runtime-controls";
    if (installed) {
      const defaultChoice = document.createElement("label");
      defaultChoice.className = "runtime-default";
      const defaultInput = document.createElement("input");
      defaultInput.type = "radio";
      defaultInput.name = "defaultRuntime";
      defaultInput.value = runtime.id;
      defaultInput.checked = selected && runtime.id === defaultRuntimeId;
      defaultInput.disabled = !selected;
      defaultInput.setAttribute("aria-label", `Use ${runtime.label} as the default coding agent`);
      const defaultLabel = document.createElement("span");
      defaultLabel.textContent = "Default";
      defaultChoice.append(defaultInput, defaultLabel);
      controls.append(defaultChoice);
    }
    const badge = document.createElement("span");
    badge.className = `runtime-state ${runtime.readiness}`;
    badge.textContent = runtime.readiness === "ready"
      ? runtime.version ?? "Ready"
      : runtime.readiness === "probe-failed"
        ? "Installed · version unknown"
        : "Not found";
    controls.append(badge);

    if (installed) {
      const access = document.createElement("span");
      access.className = "access-note";
      access.textContent = "Workspace agent";
      controls.append(access);
    }

    card.append(chooser, controls);
    runtimeList.append(card);
  }

  runtimeList.querySelectorAll<HTMLInputElement>("input[data-runtime-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const id = checkbox.dataset.runtimeId!;
      if (checkbox.checked) selectedRuntimeIds.add(id);
      else {
        selectedRuntimeIds.delete(id);
        if (defaultRuntimeId === id) {
          defaultRuntimeId = selectDiscoveredRuntimes(
            discoveredRuntimes.filter((runtime) => selectedRuntimeIds.has(runtime.id)),
          ).defaultRuntimeId;
        }
      }
      renderRuntimeCards();
      updateLaunchState();
    });
  });
  runtimeList.querySelectorAll<HTMLInputElement>("input[name='defaultRuntime']").forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked || !selectedRuntimeIds.has(radio.value)) return;
      defaultRuntimeId = radio.value;
      renderRuntimeCards();
      updateLaunchState();
    });
  });
  renderPreviewRoster();
  updateLaunchState();
};

const discoverRuntimes = async (
  savedSelection?: Pick<SavedDesktopSetup, "runtimeIds" | "defaultRuntimeId">,
): Promise<void> => {
  runtimeList.innerHTML = '<div class="runtime-loading">Looking for Codex, Claude Code, Pi, and Hermes…</div>';
  refreshButton.disabled = true;
  launchButton.disabled = true;
  status.textContent = "Inspecting installed coding agents…";
  try {
    discoveredRuntimes = await invoke<readonly DiscoveredRuntime[]>("discover_coding_runtimes");
    selectedRuntimeIds.clear();
    const selection = selectDiscoveredRuntimes(discoveredRuntimes, savedSelection);
    for (const id of selection.runtimeIds) selectedRuntimeIds.add(id);
    defaultRuntimeId = selection.defaultRuntimeId;
    canAutoResume = selection.canAutoResume;
    renderRuntimeCards();
    const installed = discoveredRuntimes.filter((runtime) => runtime.executablePath).length;
    status.textContent = installed > 0
      ? `Found ${installed} local coding agent${installed === 1 ? "" : "s"}. Review the roster, then open the room.`
      : "No supported coding agents were found on this device.";
  } catch (error) {
    runtimeList.innerHTML = '<div class="runtime-loading is-error">Agent discovery failed. Scan again to retry.</div>';
    status.textContent = errorMessage(error);
  } finally {
    refreshButton.disabled = false;
  }
};

folderButton.addEventListener("click", async () => {
  folderButton.disabled = true;
  status.textContent = "Opening folder picker…";

  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a repository for Roster",
    });

    if (selected) {
      repositoryPath = selected;
      repositorySummary.textContent = selected;
      folderActionLabel.textContent = `Change ${shortPath(selected)}`;
      runtimePanel.hidden = false;
      setStep("runtimes");
      await discoverRuntimes();
    } else {
      status.textContent = repositoryPath ? `Using ${repositoryPath}` : "No folder selected.";
    }
  } catch (error) {
    console.error("Roster desktop onboarding failed", error);
    status.textContent = errorMessage(error);
  } finally {
    folderButton.disabled = false;
  }
});

refreshButton.addEventListener("click", () => {
  void discoverRuntimes();
});

const launchRosterRuntimeAttempt = async (): Promise<void> => {
  const profiles = selectedProfiles();
  if (!repositoryPath || profiles.length === 0) return;
  launchButton.disabled = true;
  folderButton.disabled = true;
  refreshButton.disabled = true;
  setStep("room");
  runtimeErrorPanel.hidden = true;
  status.textContent = "Starting the local Roster runtime and joining the room…";
  try {
    const session = await invoke<RuntimeSession>("start_roster_runtime", {
      workspacePath: repositoryPath,
      runtimeProfilesJson: JSON.stringify(profiles),
      defaultRuntimeId,
    });
    status.textContent = `Opening ${session.repositoryPath}`;
    window.location.assign(session.codingUrl);
  } catch (error) {
    console.error("Roster runtime failed to start");
    setStep("runtimes");
    showRuntimeError(error);
    launchButton.disabled = false;
    folderButton.disabled = false;
    refreshButton.disabled = false;
  }
};

const launchRosterRuntime = createSingleFlightAction(launchRosterRuntimeAttempt);

launchButton.addEventListener("click", launchRosterRuntime);
retryRuntimeButton.addEventListener("click", launchRosterRuntime);
copyRuntimeErrorButton.addEventListener("click", async () => {
  await copyRuntimeDiagnostic({
    details: runtimeErrorDetails,
    status,
    writeText: (value) => navigator.clipboard.writeText(value),
  });
});

const resumeSavedSetup = async (): Promise<void> => {
  folderButton.disabled = true;
  status.textContent = "Checking your last Roster workspace…";
  try {
    const saved = await invoke<SavedDesktopSetup | null>("load_saved_desktop_setup");
    if (!saved) {
      status.textContent = "Choose a repository to begin.";
      return;
    }
    repositoryPath = saved.repositoryPath;
    repositorySummary.textContent = saved.repositoryPath;
    folderActionLabel.textContent = `Change ${shortPath(saved.repositoryPath)}`;
    runtimePanel.hidden = false;
    setStep("runtimes");
    await discoverRuntimes(saved);
    if (
      !canAutoResume
      || selectedProfiles().length === 0
      || !defaultRuntimeId
      || !selectedRuntimeIds.has(defaultRuntimeId)
    ) {
      status.textContent = "Your repository is still selected, but its saved coding agents are unavailable. Review the roster to continue.";
      return;
    }
    status.textContent = `Reopening ${saved.repositoryPath}…`;
    await launchRosterRuntime();
  } catch (error) {
    console.error("Roster could not reopen the saved workspace", error);
    status.textContent = `${errorMessage(error)} Choose a repository to continue.`;
  } finally {
    if (!window.location.href.startsWith("http://127.0.0.1:")) {
      folderButton.disabled = false;
    }
  }
};

void resumeSavedSetup();
