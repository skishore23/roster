export const CODING_WORKBENCH_TABS = ["work", "files", "team", "details"] as const;

export type CodingWorkbenchTab = typeof CODING_WORKBENCH_TABS[number];

export interface CodingOverlayElement extends EventTarget {
  hidden: boolean;
  inert: boolean;
  readonly dataset: Record<string, string | undefined>;
  readonly disabled?: boolean;
  readonly tabIndex?: number;
  focus(options?: FocusOptions): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  contains(target: unknown): boolean;
  querySelectorAll(selector: string): ArrayLike<CodingOverlayElement>;
}

type CodingMediaState = EventTarget & { readonly matches: boolean };

type CodingNavigationMode = "push" | "replace";

export interface CodingWorkspaceOverlayControllerInput {
  readonly root: CodingOverlayElement;
  readonly rail: CodingOverlayElement;
  readonly workbench: CodingOverlayElement;
  readonly railToggle: CodingOverlayElement;
  readonly railClose: CodingOverlayElement;
  readonly workbenchToggle: CodingOverlayElement;
  readonly workbenchClose: CodingOverlayElement;
  readonly scrim: CodingOverlayElement;
  readonly background: readonly CodingOverlayElement[];
  readonly keyboard: EventTarget;
  readonly history: EventTarget;
  readonly workbenchMedia: CodingMediaState;
  readonly railMedia: CodingMediaState;
  readonly workbenchTabs?: readonly CodingOverlayElement[];
  readonly workbenchPanels?: readonly CodingOverlayElement[];
  readonly currentUrl: () => URL;
  readonly navigate: (url: URL, mode: CodingNavigationMode) => void;
  readonly activeElement: () => unknown;
  readonly hasOpenDialog: () => boolean;
  readonly defer: (callback: () => void) => void;
}

export interface CodingWorkspaceOverlayController {
  start(): void;
  destroy(): void;
  openRail(options?: { readonly restoreTarget?: CodingOverlayElement }): void;
  closeRail(options?: { readonly restoreFocus?: boolean }): void;
  openWorkbench(tab?: CodingWorkbenchTab, options?: {
    readonly updateUrl?: boolean;
    readonly focusClose?: boolean;
    readonly restoreTarget?: CodingOverlayElement;
  }): void;
  closeWorkbench(options?: { readonly updateUrl?: boolean; readonly restoreFocus?: boolean }): void;
  selectWorkbenchTab(tab: string | undefined, options?: {
    readonly updateUrl?: boolean;
    readonly focusTab?: boolean;
  }): void;
  restoreFromUrl(): void;
  snapshot(): {
    readonly overlay?: "rail" | "workbench";
    readonly railOpen: boolean;
    readonly workbenchOpen: boolean;
    readonly workbenchTab: CodingWorkbenchTab;
    readonly workbenchModal: boolean;
  };
}

export const canonicalCodingWorkbenchUrl = (input: URL): {
  readonly url: URL;
  readonly tab?: CodingWorkbenchTab;
  readonly changed: boolean;
} => {
  const url = new URL(input.href);
  const requested = url.searchParams.getAll("workbench");
  const tab = requested.find((value): value is CodingWorkbenchTab =>
    CODING_WORKBENCH_TABS.includes(value as CodingWorkbenchTab));
  const canonical = tab ? [tab] : [];
  const changed = requested.length !== canonical.length
    || requested.some((value, index) => value !== canonical[index]);
  if (changed) {
    url.searchParams.delete("workbench");
    if (tab) url.searchParams.set("workbench", tab);
  }
  return { url, ...(tab ? { tab } : {}), changed };
};

export const shouldAutofocusCodingEmptyComposer = (input: {
  readonly hasEmptyRoom: boolean;
  readonly socialRowCount: number;
  readonly composerCount: number;
  readonly focusIsNeutral: boolean;
}): boolean => input.hasEmptyRoom
  && input.socialRowCount === 0
  && input.composerCount === 1
  && input.focusIsNeutral;

export const autofocusCodingEmptyComposer = (input: {
  readonly composer?: Pick<CodingOverlayElement, "focus">;
  readonly defer: (callback: () => void) => void;
  readonly hasEmptyRoom: boolean;
  readonly socialRowCount: number;
  readonly composerCount: number;
  readonly focusIsNeutral: boolean;
}): boolean => {
  if (!input.composer || !shouldAutofocusCodingEmptyComposer(input)) return false;
  input.defer(() => input.composer?.focus({ preventScroll: true }));
  return true;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const isFocusable = (element: CodingOverlayElement): boolean => !element.hidden
  && !element.inert
  && !element.disabled
  && element.tabIndex !== -1
  && element.getAttribute("aria-hidden") !== "true";

export const createCodingWorkspaceOverlayController = (
  input: CodingWorkspaceOverlayControllerInput,
): CodingWorkspaceOverlayController => {
  let started = false;
  let railOpen = false;
  let workbenchOpen = false;
  let workbenchTab: CodingWorkbenchTab = "work";
  let workbenchReturnFocus: CodingOverlayElement = input.workbenchToggle;
  let railReturnFocus: CodingOverlayElement = input.railToggle;
  let overlay: "rail" | "workbench" | undefined;
  let workbenchModal = false;
  const modalCandidates = [...new Set([...input.background, input.rail, input.workbench])];
  const baseline = new Map(modalCandidates.map((element) => [element, {
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  }]));
  const listeners: Array<{
    readonly target: EventTarget;
    readonly type: string;
    readonly listener: EventListener;
  }> = [];

  const listen = (target: EventTarget, type: string, listener: EventListener): void => {
    target.addEventListener(type, listener);
    listeners.push({ target, type, listener });
  };

  const restoreBackground = (): void => {
    for (const [element, state] of baseline) {
      element.inert = state.inert;
      if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", state.ariaHidden);
    }
  };

  const setModalBackground = (active: "rail" | "workbench" | undefined): void => {
    restoreBackground();
    if (!active) return;
    const activeSurface = active === "workbench" ? input.workbench : input.rail;
    for (const element of modalCandidates) {
      if (element === activeSurface) continue;
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
  };

  const setDialogSemantics = (element: CodingOverlayElement, modal: boolean): void => {
    if (modal) {
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-modal", "true");
    } else {
      element.removeAttribute("role");
      element.removeAttribute("aria-modal");
    }
  };

  const syncWorkbenchTab = (): void => {
    for (const trigger of input.workbenchTabs ?? []) {
      const selected = trigger.dataset.codingWorkbenchTab === workbenchTab;
      trigger.setAttribute("aria-selected", String(selected));
      trigger.setAttribute("tabindex", selected ? "0" : "-1");
    }
    for (const panel of input.workbenchPanels ?? []) {
      panel.hidden = panel.dataset.codingWorkbenchPanel !== workbenchTab;
    }
    input.workbench.dataset.workbenchTab = workbenchTab;
  };

  const sync = (): void => {
    if (!input.railMedia.matches) railOpen = false;
    input.rail.hidden = input.railMedia.matches ? !railOpen : false;
    input.workbench.hidden = !workbenchOpen;
    input.railToggle.setAttribute("aria-expanded", String(railOpen));
    input.workbenchToggle.setAttribute("aria-expanded", String(workbenchOpen));
    input.root.dataset.codingContextCast = workbenchOpen ? "open" : "closed";
    workbenchModal = workbenchOpen && input.workbenchMedia.matches;
    const railModal = railOpen && input.railMedia.matches;
    overlay = workbenchModal ? "workbench" : railModal ? "rail" : undefined;
    if (overlay) input.root.dataset.overlayOpen = overlay;
    else delete input.root.dataset.overlayOpen;
    input.scrim.hidden = !overlay;
    input.scrim.setAttribute(
      "aria-label",
      overlay === "rail" ? "Close repository navigation" : "Close Workbench",
    );
    setDialogSemantics(input.workbench, workbenchModal);
    setDialogSemantics(input.rail, railModal);
    setModalBackground(overlay);
    syncWorkbenchTab();
  };

  const writeWorkbenchUrl = (tab: CodingWorkbenchTab | undefined, mode: CodingNavigationMode): void => {
    const current = input.currentUrl();
    const next = new URL(current.href);
    next.searchParams.delete("workbench");
    if (tab) next.searchParams.set("workbench", tab);
    if (next.href !== current.href) input.navigate(next, mode);
  };

  const closeRail = (options: { readonly restoreFocus?: boolean } = {}): void => {
    const wasOpen = railOpen;
    railOpen = false;
    sync();
    if (wasOpen && options.restoreFocus !== false) input.defer(() => railReturnFocus.focus());
  };

  const openRail = (options: { readonly restoreTarget?: CodingOverlayElement } = {}): void => {
    if (!input.railMedia.matches) return;
    railReturnFocus = options.restoreTarget ?? input.railToggle;
    if (workbenchOpen) {
      workbenchOpen = false;
      writeWorkbenchUrl(undefined, "push");
    }
    railOpen = true;
    sync();
    input.defer(() => input.railClose.focus());
  };

  const closeWorkbench = (options: {
    readonly updateUrl?: boolean;
    readonly restoreFocus?: boolean;
  } = {}): void => {
    const wasOpen = workbenchOpen;
    workbenchOpen = false;
    sync();
    if (options.updateUrl !== false) writeWorkbenchUrl(undefined, "push");
    if (wasOpen && options.restoreFocus !== false) input.defer(() => workbenchReturnFocus.focus());
  };

  const openWorkbench = (
    tab: CodingWorkbenchTab = workbenchTab,
    options: {
      readonly updateUrl?: boolean;
      readonly focusClose?: boolean;
      readonly restoreTarget?: CodingOverlayElement;
    } = {},
  ): void => {
    const wasOpen = workbenchOpen;
    workbenchTab = tab;
    workbenchReturnFocus = options.restoreTarget ?? input.workbenchToggle;
    railOpen = false;
    workbenchOpen = true;
    sync();
    if (options.updateUrl !== false) writeWorkbenchUrl(workbenchTab, "push");
    if (input.workbenchMedia.matches && (options.focusClose !== false || !wasOpen)) {
      input.defer(() => input.workbenchClose.focus());
    }
  };

  const selectWorkbenchTab = (
    requested: string | undefined,
    options: { readonly updateUrl?: boolean; readonly focusTab?: boolean } = {},
  ): void => {
    const tab = CODING_WORKBENCH_TABS.includes(requested as CodingWorkbenchTab)
      ? requested as CodingWorkbenchTab
      : "work";
    const wasOpen = workbenchOpen;
    openWorkbench(tab, {
      updateUrl: options.updateUrl,
      focusClose: !wasOpen,
    });
    if (options.focusTab) {
      const trigger = (input.workbenchTabs ?? []).find((candidate) =>
        candidate.dataset.codingWorkbenchTab === tab);
      trigger?.focus();
    }
  };

  const restoreFromUrl = (): void => {
    const canonical = canonicalCodingWorkbenchUrl(input.currentUrl());
    if (canonical.changed) input.navigate(canonical.url, "replace");
    if (canonical.tab) {
      workbenchTab = canonical.tab;
      railOpen = false;
      workbenchOpen = true;
    } else {
      workbenchOpen = false;
    }
    sync();
  };

  const containFocus = (event: KeyboardEvent): boolean => {
    if (event.key !== "Tab" || !overlay) return false;
    const surface = overlay === "workbench" ? input.workbench : input.rail;
    const focusables = Array.from(surface.querySelectorAll(focusableSelector)).filter(isFocusable);
    if (focusables.length === 0) {
      event.preventDefault();
      (overlay === "workbench" ? input.workbenchClose : input.railClose).focus();
      return true;
    }
    const active = input.activeElement();
    const index = focusables.findIndex((candidate) => candidate === active);
    const atStart = index <= 0;
    const atEnd = index === focusables.length - 1;
    if (!surface.contains(active) || (event.shiftKey && atStart) || (!event.shiftKey && atEnd)) {
      event.preventDefault();
      (event.shiftKey ? focusables.at(-1) : focusables[0])?.focus();
      return true;
    }
    return false;
  };

  const onKeydown = (eventValue: Event): void => {
    if (eventValue.defaultPrevented) return;
    const event = eventValue as KeyboardEvent;
    if (containFocus(event)) return;
    if (event.key === "Escape" && overlay && !input.hasOpenDialog()) {
      event.preventDefault();
      if (overlay === "workbench") closeWorkbench();
      else closeRail();
      return;
    }
    const key = event.key.toLocaleLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "j") {
      event.preventDefault();
      if (workbenchOpen) closeWorkbench();
      else openWorkbench(workbenchTab);
      return;
    }
    if (event.altKey && ["1", "2", "3", "4"].includes(event.key)) {
      event.preventDefault();
      selectWorkbenchTab(CODING_WORKBENCH_TABS[Number(event.key) - 1]);
      return;
    }
    const trigger = (input.workbenchTabs ?? []).find((candidate) => candidate === event.target);
    if (!trigger || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = input.workbenchTabs ?? [];
    const index = tabs.indexOf(trigger);
    if (index < 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    selectWorkbenchTab(tabs[nextIndex]?.dataset.codingWorkbenchTab, { focusTab: true });
  };

  const onResponsiveChange = (): void => {
    const wasModal = workbenchModal;
    if (input.railMedia.matches) railOpen = false;
    sync();
    if (!wasModal && workbenchModal) {
      input.defer(() => input.workbenchClose.focus());
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    const canonical = canonicalCodingWorkbenchUrl(input.currentUrl());
    if (canonical.changed) input.navigate(canonical.url, "replace");
    const defaultTab = input.workbench.dataset.defaultTab;
    workbenchTab = canonical.tab
      ?? (CODING_WORKBENCH_TABS.includes(defaultTab as CodingWorkbenchTab)
        ? defaultTab as CodingWorkbenchTab
        : "work");
    const hashOpensWorkbench = input.currentUrl().hash.startsWith("#coding-agent-detail-")
      || input.currentUrl().hash.startsWith("#coding-cast-");
    workbenchOpen = Boolean(canonical.tab) || hashOpensWorkbench;
    if (hashOpensWorkbench && !canonical.tab) writeWorkbenchUrl(workbenchTab, "replace");
    railOpen = false;
    sync();
    if (workbenchOpen && input.workbenchMedia.matches) input.defer(() => input.workbenchClose.focus());
    listen(input.railToggle, "click", () => railOpen ? closeRail() : openRail());
    listen(input.railClose, "click", () => closeRail());
    listen(input.workbenchToggle, "click", () => workbenchOpen ? closeWorkbench() : openWorkbench());
    listen(input.workbenchClose, "click", () => closeWorkbench());
    listen(input.scrim, "click", () => {
      if (overlay === "workbench") closeWorkbench();
      else if (overlay === "rail") closeRail();
    });
    for (const trigger of input.workbenchTabs ?? []) {
      listen(trigger, "click", () => selectWorkbenchTab(trigger.dataset.codingWorkbenchTab, {
        updateUrl: true,
      }));
    }
    listen(input.keyboard, "keydown", onKeydown);
    listen(input.history, "popstate", restoreFromUrl);
    listen(input.workbenchMedia, "change", onResponsiveChange);
    listen(input.railMedia, "change", onResponsiveChange);
  };

  const destroy = (): void => {
    for (const { target, type, listener } of listeners) target.removeEventListener(type, listener);
    listeners.length = 0;
    restoreBackground();
    started = false;
  };

  return {
    start,
    destroy,
    openRail,
    closeRail,
    openWorkbench,
    closeWorkbench,
    selectWorkbenchTab,
    restoreFromUrl,
    snapshot: () => ({
      ...(overlay ? { overlay } : {}),
      railOpen,
      workbenchOpen,
      workbenchTab,
      workbenchModal,
    }),
  };
};

const asOverlayElement = (element: Element | null): CodingOverlayElement | undefined =>
  element instanceof HTMLElement ? element as unknown as CodingOverlayElement : undefined;

export const installCodingWorkspaceInteraction = (): CodingWorkspaceOverlayController | undefined => {
  const root = asOverlayElement(document.documentElement);
  const rail = asOverlayElement(document.querySelector("[data-coding-project-rail]"));
  const workbench = asOverlayElement(document.querySelector('[data-slot="context-cast"]'));
  const railToggle = asOverlayElement(document.querySelector("[data-coding-rail-toggle]"));
  const railClose = asOverlayElement(document.querySelector("[data-coding-rail-close]"));
  const workbenchToggle = asOverlayElement(document.querySelector("[data-coding-context-toggle]"));
  const workbenchClose = asOverlayElement(document.querySelector("[data-coding-context-close]"));
  const scrim = asOverlayElement(document.querySelector("[data-coding-overlay-scrim]"));
  if (!root || !rail || !workbench || !railToggle || !railClose
    || !workbenchToggle || !workbenchClose || !scrim) return undefined;
  const background = [
    document.querySelector('[data-slot="room-header"]'),
    document.querySelector(".coding-conversation-scroll"),
    document.querySelector(".coding-composer-wrap"),
    document.querySelector("[data-coding-new-messages]"),
  ].flatMap((element) => asOverlayElement(element) ?? []);
  const tabs = [...document.querySelectorAll("[data-coding-workbench-tab]")]
    .flatMap((element) => asOverlayElement(element) ?? []);
  const panels = [...document.querySelectorAll("[data-coding-workbench-panel]")]
    .flatMap((element) => asOverlayElement(element) ?? []);
  const controller = createCodingWorkspaceOverlayController({
    root,
    rail,
    workbench,
    railToggle,
    railClose,
    workbenchToggle,
    workbenchClose,
    scrim,
    background,
    keyboard: document,
    history: window,
    workbenchMedia: window.matchMedia("(max-width: 1179px)"),
    railMedia: window.matchMedia("(max-width: 899px)"),
    workbenchTabs: tabs,
    workbenchPanels: panels,
    currentUrl: () => new URL(location.href),
    navigate: (url, mode) => {
      if (mode === "replace") history.replaceState(history.state, "", url);
      else history.pushState(history.state, "", url);
    },
    activeElement: () => document.activeElement,
    hasOpenDialog: () => Boolean(document.querySelector("dialog[open]")),
    defer: (callback) => queueMicrotask(callback),
  });
  controller.start();
  document.addEventListener("coding:open-context", () => controller.openWorkbench());
  document.addEventListener("coding:open-workbench", (event) => {
    const detail = event instanceof CustomEvent && event.detail && typeof event.detail === "object"
      ? event.detail as { readonly tab?: string }
      : undefined;
    controller.selectWorkbenchTab(detail?.tab);
  });

  const composer = [...document.querySelectorAll<HTMLTextAreaElement>("[data-coding-form] textarea")];
  const focusIsNeutral = document.activeElement === null
    || document.activeElement === document.body
    || document.activeElement === document.documentElement;
  autofocusCodingEmptyComposer({
    composer: composer[0] as unknown as CodingOverlayElement | undefined,
    defer: (callback) => queueMicrotask(callback),
    hasEmptyRoom: Boolean(document.querySelector("[data-room-empty]")),
    socialRowCount: document.querySelectorAll("[data-coding-social-row]").length,
    composerCount: composer.length,
    focusIsNeutral,
  });
  return controller;
};
