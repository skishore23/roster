import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { THEME_STORAGE_KEY, themeBootstrapScript, themeContrastPairs, themeCss, themeSelectorHtml } from "../../src/views/theme.ts";

const channel = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const contrast = (foreground: string, background: string): number => {
  const luminance = (hex: string): number => {
    const red = channel(`#${hex.slice(1, 3)}`);
    const green = channel(`#${hex.slice(3, 5)}`);
    const blue = channel(`#${hex.slice(5, 7)}`);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

test("theme contract is local, dark-first, three-state, and nonce-aware", () => {
  assert.equal(THEME_STORAGE_KEY, "roster.theme.preference.v2");
  const script = themeBootstrapScript("nonce-value");
  assert.match(script, /nonce="nonce-value"/);
  assert.match(script, /localStorage/);
  assert.match(script, /prefers-color-scheme: dark/);
  assert.match(script, /storage/);
  assert.doesNotMatch(script, /\.style\./);
  assert.doesNotMatch(script, /fetch|XMLHttpRequest|cookie/i);
  assert.match(themeSelectorHtml(), /aria-label="Theme"/);
  assert.match(themeSelectorHtml(), /data-ui-select/);
  assert.doesNotMatch(themeSelectorHtml(), / name=/);
  assert.match(script, /aria-haspopup/);
  assert.match(script, /MutationObserver/);
  assert.match(themeCss(), /\.ui-select-trigger/);
});

test("light semantic token representatives meet AA contrast", () => {
  for (const [foreground, background] of themeContrastPairs) assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  assert.match(themeCss(), /data-theme="light"/);
  assert.match(themeCss(), /--text-tertiary:#596052/);
});


test("theme runtime handles storage clearing and actual semantic surfaces", () => {
  const script = themeBootstrapScript();
  assert.match(script, /event\.key!==null&&event\.key!==key/);
  assert.match(script, /event\.newValue&&valid\.has\(event\.newValue\)\?event\.newValue:'dark'/);
  const css = themeCss();
  for (const token of ["--surface-sidebar:#ebe9df", "--success-surface:#edf5e9", "--warning-surface:#fff7df", "--danger-surface:#fff0ed"]) assert.match(css, new RegExp(token));
});

test("theme bootstrap persists preference and reacts to System and storage changes", () => {
  const stored = new Map<string, string>([[THEME_STORAGE_KEY, "system"]]);
  const root = { dataset: {} as Record<string, string> };
  const meta = { content: "", setAttribute: (_name: string, value: string) => { meta.content = value; } };
  const selectListeners = new Map<string, () => void>();
  const select = {
    value: "",
    setAttribute: () => undefined,
    addEventListener: (type: string, listener: () => void) => { selectListeners.set(type, listener); },
  };
  const mediaListeners = new Map<string, () => void>();
  const media = {
    matches: false,
    addEventListener: (type: string, listener: () => void) => { mediaListeners.set(type, listener); },
  };
  const windowListeners = new Map<string, (event: { key: string | null; newValue: string | null }) => void>();
  const source = themeBootstrapScript().replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");
  vm.runInNewContext(source, {
    document: {
      documentElement: root,
      readyState: "complete",
      querySelector: (selector: string) => selector === 'meta[name="theme-color"]' ? meta : null,
      querySelectorAll: (selector: string) => selector.includes("Theme") || selector === "[data-theme-select]" ? [select] : [],
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    },
    window: {
      matchMedia: () => media,
      addEventListener: (type: string, listener: (event: { key: string | null; newValue: string | null }) => void) => {
        windowListeners.set(type, listener);
      },
    },
  });

  assert.deepEqual(root.dataset, { theme: "light" });
  assert.equal(select.value, "system");
  assert.equal(meta.content, "#f3f0e8");

  media.matches = true;
  mediaListeners.get("change")?.();
  assert.equal(root.dataset.theme, "dark");
  assert.equal(select.value, "system");

  select.value = "light";
  selectListeners.get("change")?.();
  assert.equal(stored.get(THEME_STORAGE_KEY), "light");
  assert.equal(root.dataset.theme, "light");

  windowListeners.get("storage")?.({ key: THEME_STORAGE_KEY, newValue: "dark" });
  assert.equal(root.dataset.theme, "dark");
  assert.equal(select.value, "dark");
  windowListeners.get("storage")?.({ key: "unrelated", newValue: "light" });
  assert.equal(root.dataset.theme, "dark");
  media.matches = false;
  windowListeners.get("storage")?.({ key: null, newValue: null });
  assert.equal(root.dataset.theme, "dark");
  assert.equal(select.value, "dark");
});

test("theme runtime defaults new workspaces to Roster dark", () => {
  const root = { dataset: {} as Record<string, string> };
  const select = {
    value: "",
    setAttribute: () => undefined,
    addEventListener: () => undefined,
  };
  const source = themeBootstrapScript().replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");
  vm.runInNewContext(source, {
    document: {
      documentElement: root,
      readyState: "complete",
      querySelector: () => null,
      querySelectorAll: () => [select],
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      addEventListener: () => undefined,
    },
  });
  assert.deepEqual(root.dataset, { theme: "dark" });
  assert.equal(select.value, "dark");
});

test("Coding emits one theme token layer and nonce-bearing bootstrap", async () => {
  const source = await readFile(new URL("../../src/views/coding.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../src/views/coding-style.ts", import.meta.url), "utf8");
  assert.equal(source.match(/\$\{themeCss\(\)\}/g)?.length, 2);
  assert.equal(source.match(/\$\{themeBootstrapScript\(options\.nonce\)\}/g)?.length, 2);
  assert.match(source + styles, /coding-workspace-settings\{[^}]+background:var\(--surface-inset/);
  assert.doesNotMatch(source + styles, /coding-workspace-settings\{[^}]+background:#111/);
  assert.match(source + styles, /coding-workspace-settings button\[type="submit"\]/);
  assert.doesNotMatch(source + styles, /coding-workspace-settings button\{/);
});
