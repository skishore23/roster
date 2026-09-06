import { installCodingWorkspaceInteraction } from "./coding-workspace-interaction.js";

const MERMAID_SELECTOR = [
  ".coding-message-body pre[lang='mermaid'] > code",
  ".coding-message-body pre > code.mermaid",
  ".coding-message-body pre > code.language-mermaid",
  ".coding-message-body pre > code.lang-mermaid",
].join(",");
let mermaidRenderer: Promise<typeof import("./coding-mermaid-renderer.js")> | undefined;
const scheduleMermaidRender = (): void => {
  if (!document.querySelector(MERMAID_SELECTOR)) return;
  mermaidRenderer ??= import("./coding-mermaid-renderer.js");
  void mermaidRenderer.then((renderer) => renderer.scheduleMermaidRender());
};

type MentionToken = {
  readonly start: number;
  readonly end: number;
  readonly query: string;
};

const installMentionPicker = (): void => {
  const form = document.querySelector<HTMLFormElement>("[data-coding-form]");
  const textarea = form?.querySelector<HTMLTextAreaElement>("#coding-objective");
  const menu = form?.querySelector<HTMLDetailsElement>("[data-coding-mention-menu]");
  const summary = menu?.querySelector<HTMLElement>("summary");
  const empty = menu?.querySelector<HTMLElement>("[data-coding-mention-empty]");
  const options = menu
    ? [...menu.querySelectorAll<HTMLButtonElement>("[data-coding-mention]")]
    : [];
  if (!textarea || !menu || !summary || options.length === 0) return;

  let activeIndex = -1;
  let openedByTyping = false;

  const currentToken = (): MentionToken | undefined => {
    if (textarea.selectionStart !== textarea.selectionEnd) return undefined;
    const end = textarea.selectionStart;
    const match = textarea.value.slice(0, end).match(/(^|\s)@([a-z0-9._-]*)$/i);
    if (!match) return undefined;
    return {
      start: end - match[0].length + match[1].length,
      end,
      query: match[2].toLowerCase(),
    };
  };

  const visibleOptions = (): HTMLButtonElement[] => options.filter((option) => !option.hidden);

  const setActive = (index: number): void => {
    const visible = visibleOptions();
    activeIndex = visible.length ? (index + visible.length) % visible.length : -1;
    for (const option of options) {
      const active = activeIndex >= 0 && option === visible[activeIndex];
      option.dataset.active = String(active);
      option.setAttribute("aria-selected", String(active));
    }
    const selected = activeIndex >= 0 ? visible[activeIndex] : undefined;
    if (selected) textarea.setAttribute("aria-activedescendant", selected.id);
    else textarea.removeAttribute("aria-activedescendant");
    selected?.scrollIntoView({ block: "nearest" });
  };

  const filterOptions = (query: string): void => {
    const normalized = query.trim().toLowerCase();
    for (const option of options) {
      const mention = option.dataset.codingMention?.slice(1).toLowerCase() ?? "";
      const searchable = `${mention} ${option.textContent ?? ""}`.toLowerCase();
      option.hidden = Boolean(normalized && !searchable.includes(normalized));
    }
    if (empty) empty.hidden = visibleOptions().length > 0;
    setActive(0);
  };

  const setOpen = (open: boolean, fromTyping = false): void => {
    menu.open = open;
    openedByTyping = open && fromTyping;
    summary.setAttribute("aria-expanded", String(open));
    textarea.setAttribute("aria-expanded", String(open));
    if (!open) {
      for (const option of options) {
        option.hidden = false;
        option.dataset.active = "false";
        option.setAttribute("aria-selected", "false");
      }
      if (empty) empty.hidden = true;
      activeIndex = -1;
      textarea.removeAttribute("aria-activedescendant");
    }
  };

  const insertMention = (option: HTMLButtonElement): void => {
    const mention = option.dataset.codingMention;
    if (!mention) return;
    const token = currentToken();
    const selectionStart = token?.start ?? textarea.selectionStart;
    const selectionEnd = token?.end ?? textarea.selectionEnd;
    const before = textarea.value.slice(0, selectionStart);
    const after = textarea.value.slice(selectionEnd);
    const prefix = token ? "" : before && !/\s$/.test(before) ? " " : "";
    const suffix = after && /^\s/.test(after) ? "" : " ";
    textarea.setRangeText(`${prefix}${mention}${suffix}`, selectionStart, selectionEnd, "end");
    setOpen(false);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  };

  textarea.addEventListener("input", () => {
    const token = currentToken();
    if (!token) {
      if (openedByTyping) setOpen(false);
      return;
    }
    filterOptions(token.query);
    setOpen(true, true);
  });

  textarea.addEventListener("keydown", (event) => {
    if (!menu.open || !currentToken()) return;
    const visible = visibleOptions();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && activeIndex >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const option = visible[activeIndex];
      if (option) insertMention(option);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
    }
  }, true);

  for (const option of options) {
    option.addEventListener("click", () => insertMention(option));
  }
  menu.addEventListener("toggle", () => {
    const open = menu.open;
    summary.setAttribute("aria-expanded", String(open));
    textarea.setAttribute("aria-expanded", String(open));
    if (open && !openedByTyping) filterOptions("");
  });
  summary.setAttribute("aria-expanded", "false");
  textarea.setAttribute("aria-expanded", "false");
};

installMentionPicker();
installCodingWorkspaceInteraction();
scheduleMermaidRender();
document.addEventListener("coding:run-panel-updated", scheduleMermaidRender);
document.addEventListener("coding:realtime-applied", scheduleMermaidRender);
