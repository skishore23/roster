declare const __ROSTER_CODING_BUILD__: string;

export const CODING_BROWSER_BUILD = typeof __ROSTER_CODING_BUILD__ === "string"
  ? __ROSTER_CODING_BUILD__
  : "";

export const CODING_COMPOSER_DRAFT_KEY = "roster.coding.composer-draft.v1";

export function codingBuildMismatch(pageBuild: string | null, browserBuild: string): boolean {
  return typeof pageBuild === "string" && pageBuild.length > 0 && pageBuild !== browserBuild;
}

export function resolveCodingBuildStorage(readStorage: () => Storage): Storage | undefined {
  try {
    return readStorage();
  } catch {
    return undefined;
  }
}

export function initializeCodingBuildGuard(document: Document, storage: Storage | undefined): void {
  const composer = document.querySelector<HTMLTextAreaElement>("[data-coding-composer-input]");
  try {
    const draft = storage?.getItem(CODING_COMPOSER_DRAFT_KEY);
    if (composer && !composer.value && draft !== null && draft !== undefined) {
      composer.value = draft;
      storage?.removeItem(CODING_COMPOSER_DRAFT_KEY);
    }
  } catch {
    // Private browsing or a disabled storage area must not block the room.
  }

  const pageBuild = document.querySelector<HTMLMetaElement>("meta[name=\"roster-coding-build\"]")?.content ?? null;
  const mismatch = codingBuildMismatch(pageBuild, CODING_BROWSER_BUILD);
  const notice = document.querySelector<HTMLElement>("[data-coding-build-mismatch]");
  if (notice) notice.hidden = !mismatch;
  const reload = document.querySelector<HTMLButtonElement>("[data-coding-build-reload]");
  if (!mismatch || !reload) return;
  reload.addEventListener("click", () => {
    const draft = composer?.value ?? "";
    try {
      storage?.setItem(CODING_COMPOSER_DRAFT_KEY, draft);
    } catch {
      if (draft) return;
    }
    if (draft && !storage) return;
    window.location.reload();
  });
}
