import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  autofocusCodingEmptyComposer,
  canonicalCodingWorkbenchUrl,
  createCodingWorkspaceOverlayController,
  shouldAutofocusCodingEmptyComposer,
  type CodingOverlayElement,
} from "../../src/browser/coding-workspace-interaction.ts";

class FakeElement extends EventTarget implements CodingOverlayElement {
  hidden = false;
  inert = false;
  disabled = false;
  tabIndex = 0;
  readonly dataset: Record<string, string | undefined> = {};
  readonly attributes = new Map<string, string>();
  readonly focusables: FakeElement[] = [];
  focusCount = 0;
  onFocus?: () => void;

  focus(): void {
    this.focusCount += 1;
    this.onFocus?.();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  contains(target: unknown): boolean {
    return target === this || this.focusables.includes(target as FakeElement);
  }

  querySelectorAll(): FakeElement[] {
    return this.focusables;
  }
}

class FakeMedia extends EventTarget {
  constructor(public matches: boolean) {
    super();
  }
}

const keyEvent = (key: string, options: {
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
} = {}): Event => {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    ctrlKey: { value: options.ctrlKey ?? false },
    metaKey: { value: options.metaKey ?? false },
    shiftKey: { value: options.shiftKey ?? false },
  });
  return event;
};

const harness = (width: number, initialHref = "https://roster.test/coding?workspace=workspace-test") => {
  let active: FakeElement | undefined;
  let href = initialHref;
  const navigation: Array<{ readonly mode: "push" | "replace"; readonly href: string }> = [];
  const make = (): FakeElement => {
    const element = new FakeElement();
    element.onFocus = () => { active = element; };
    return element;
  };
  const root = make();
  const rail = make();
  const workbench = make();
  const railToggle = make();
  const railClose = make();
  const workbenchToggle = make();
  const workbenchClose = make();
  const scrim = make();
  const feed = make();
  const composer = make();
  const firstTab = make();
  const lastControl = make();
  workbench.focusables.push(workbenchClose, firstTab, lastControl);
  rail.focusables.push(railClose);
  const keyboard = new EventTarget();
  const history = new EventTarget();
  const workbenchMedia = new FakeMedia(width <= 1179);
  const railMedia = new FakeMedia(width <= 899);
  const controller = createCodingWorkspaceOverlayController({
    root,
    rail,
    workbench,
    railToggle,
    railClose,
    workbenchToggle,
    workbenchClose,
    scrim,
    background: [feed, composer],
    keyboard,
    history,
    workbenchMedia,
    railMedia,
    currentUrl: () => new URL(href),
    navigate: (url, mode) => {
      href = url.href;
      navigation.push({ mode, href });
    },
    activeElement: () => active,
    hasOpenDialog: () => false,
    defer: (callback) => callback(),
  });
  controller.start();
  return {
    controller,
    root,
    rail,
    workbench,
    railToggle,
    railClose,
    workbenchToggle,
    workbenchClose,
    scrim,
    feed,
    composer,
    firstTab,
    lastControl,
    keyboard,
    history,
    workbenchMedia,
    railMedia,
    navigation,
    href: () => href,
    setHref: (next: string) => { href = next; },
    setActive: (next: FakeElement) => { active = next; },
  };
};

test("mobile rail defaults closed and remains independently operable after Workbench", () => {
  const ui = harness(390);
  assert.equal(ui.rail.hidden, true);
  assert.equal(ui.workbench.hidden, true);
  assert.equal(ui.root.dataset.overlayOpen, undefined);

  ui.railToggle.dispatchEvent(new Event("click"));
  assert.equal(ui.rail.hidden, false);
  assert.equal(ui.root.dataset.overlayOpen, "rail");
  assert.equal(ui.rail.getAttribute("role"), "dialog");
  assert.equal(ui.rail.getAttribute("aria-modal"), "true");
  assert.equal(ui.scrim.hidden, false);
  assert.equal(ui.railClose.focusCount, 1);

  ui.scrim.dispatchEvent(new Event("click"));
  assert.equal(ui.rail.hidden, true);
  assert.equal(ui.railToggle.focusCount, 1);
  ui.railToggle.dispatchEvent(new Event("click"));

  ui.workbenchToggle.dispatchEvent(new Event("click"));
  assert.equal(ui.rail.hidden, true);
  assert.equal(ui.workbench.hidden, false);
  assert.equal(ui.root.dataset.overlayOpen, "workbench");
  assert.equal(new URL(ui.href()).searchParams.get("workbench"), "work");

  ui.workbenchClose.dispatchEvent(new Event("click"));
  assert.equal(ui.workbench.hidden, true);
  assert.equal(ui.rail.hidden, true);
  assert.equal(ui.workbenchToggle.focusCount, 1);
  assert.equal(new URL(ui.href()).searchParams.has("workbench"), false);

  ui.railToggle.dispatchEvent(new Event("click"));
  ui.keyboard.dispatchEvent(keyEvent("Escape"));
  assert.equal(ui.rail.hidden, true);
  assert.equal(ui.railToggle.focusCount, 2);

  const remounted = harness(390, ui.href());
  assert.equal(remounted.rail.hidden, true);
  assert.equal(remounted.workbench.hidden, true);
});

test("responsive Workbench is modal, inert, focus-contained, URL-backed, and reversible", () => {
  const ui = harness(900);
  ui.workbenchToggle.dispatchEvent(new Event("click"));

  assert.equal(ui.workbench.getAttribute("role"), "dialog");
  assert.equal(ui.workbench.getAttribute("aria-modal"), "true");
  assert.equal(ui.feed.inert, true);
  assert.equal(ui.feed.getAttribute("aria-hidden"), "true");
  assert.equal(ui.composer.inert, true);
  assert.equal(ui.rail.inert, true);
  assert.equal(ui.workbenchClose.focusCount, 1);
  assert.equal(ui.navigation.at(-1)?.mode, "push");
  assert.equal(new URL(ui.href()).searchParams.get("workbench"), "work");

  ui.setActive(ui.lastControl);
  const forward = keyEvent("Tab");
  ui.keyboard.dispatchEvent(forward);
  assert.equal(forward.defaultPrevented, true);
  assert.equal(ui.workbenchClose.focusCount, 2);

  ui.setActive(ui.workbenchClose);
  const backward = keyEvent("Tab", { shiftKey: true });
  ui.keyboard.dispatchEvent(backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(ui.lastControl.focusCount, 1);

  ui.keyboard.dispatchEvent(keyEvent("Escape"));
  assert.equal(ui.workbench.hidden, true);
  assert.equal(ui.feed.inert, false);
  assert.equal(ui.feed.getAttribute("aria-hidden"), null);
  assert.equal(ui.workbenchToggle.focusCount, 1);
  assert.equal(new URL(ui.href()).searchParams.has("workbench"), false);
});

test("desktop Workbench stays non-modal while keyboard and history keep one canonical tab", () => {
  const ui = harness(1180, "https://roster.test/coding?workspace=workspace-test&workbench=files&workbench=files");
  assert.equal(ui.controller.snapshot().workbenchTab, "files");
  assert.equal(ui.workbench.hidden, false);
  assert.equal(ui.workbench.getAttribute("role"), null);
  assert.equal(ui.feed.inert, false);
  assert.equal(ui.navigation[0]?.mode, "replace");
  assert.equal(new URL(ui.href()).searchParams.getAll("workbench").length, 1);

  ui.keyboard.dispatchEvent(keyEvent("j", { ctrlKey: true }));
  assert.equal(ui.workbench.hidden, true);
  assert.equal(new URL(ui.href()).searchParams.has("workbench"), false);
  ui.keyboard.dispatchEvent(keyEvent("j", { ctrlKey: true }));
  assert.equal(ui.workbench.hidden, false);
  assert.equal(new URL(ui.href()).searchParams.get("workbench"), "files");

  ui.setHref("https://roster.test/coding?workspace=workspace-test&workbench=team");
  ui.history.dispatchEvent(new Event("popstate"));
  assert.equal(ui.controller.snapshot().workbenchTab, "team");
  assert.equal(ui.workbench.hidden, false);

  ui.setHref("https://roster.test/coding?workspace=workspace-test");
  ui.history.dispatchEvent(new Event("popstate"));
  assert.equal(ui.workbench.hidden, true);
});

test("canonical Workbench URLs reject obsolete or duplicate tab values", () => {
  const obsolete = canonicalCodingWorkbenchUrl(new URL("https://roster.test/coding?workbench=changes"));
  assert.equal(obsolete.tab, undefined);
  assert.equal(obsolete.url.searchParams.has("workbench"), false);
  assert.equal(obsolete.changed, true);

  const duplicate = canonicalCodingWorkbenchUrl(new URL("https://roster.test/coding?workbench=team&workbench=team"));
  assert.equal(duplicate.tab, "team");
  assert.deepEqual(duplicate.url.searchParams.getAll("workbench"), ["team"]);
  assert.equal(duplicate.changed, true);
});

test("only a genuinely empty initial room autofocuses its single composer", () => {
  assert.equal(shouldAutofocusCodingEmptyComposer({
    hasEmptyRoom: true,
    socialRowCount: 0,
    composerCount: 1,
    focusIsNeutral: true,
  }), true);
  for (const input of [
    { hasEmptyRoom: false, socialRowCount: 0, composerCount: 1, focusIsNeutral: true },
    { hasEmptyRoom: true, socialRowCount: 1, composerCount: 1, focusIsNeutral: true },
    { hasEmptyRoom: true, socialRowCount: 0, composerCount: 2, focusIsNeutral: true },
    { hasEmptyRoom: true, socialRowCount: 0, composerCount: 1, focusIsNeutral: false },
  ]) assert.equal(shouldAutofocusCodingEmptyComposer(input), false);

  const composer = new FakeElement();
  assert.equal(autofocusCodingEmptyComposer({
    composer,
    defer: (callback) => callback(),
    hasEmptyRoom: true,
    socialRowCount: 0,
    composerCount: 1,
    focusIsNeutral: true,
  }), true);
  assert.equal(composer.focusCount, 1);
  assert.equal(autofocusCodingEmptyComposer({
    composer,
    defer: (callback) => callback(),
    hasEmptyRoom: false,
    socialRowCount: 2,
    composerCount: 1,
    focusIsNeutral: true,
  }), false);
  assert.equal(composer.focusCount, 1);
});

test("production modal wiring includes the room header among inert background regions", () => {
  const source = readFileSync("src/browser/coding-workspace-interaction.ts", "utf8");
  assert.match(source, /background = \[\s*document\.querySelector\('\[data-slot="room-header"\]'\)/);
});
