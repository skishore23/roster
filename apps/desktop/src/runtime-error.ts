export const MAX_RUNTIME_DIAGNOSTIC_CHARACTERS = 8_192;

const REDACTED = "[REDACTED]";
const TRUNCATED = "\n[TRUNCATED]";

type TextTarget = { textContent: string };

export type RuntimeErrorPresentation = {
  readonly panel: { hidden: boolean | string };
  readonly summary: TextTarget;
  readonly diagnostics: { open: boolean };
  readonly details: TextTarget;
  readonly status: TextTarget;
};

const errorMessage = (error: unknown): string =>
  typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "Roster could not complete setup.";

const normalizeDiagnostic = (value: string): string => value
  .replace(/\r\n?/gu, "\n")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
  .trim();

const redactSecrets = (value: string): string => value
  .replace(
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
    REDACTED,
  )
  .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, (match) => `${match.split(/\s+/u, 1)[0]} ${REDACTED}`)
  .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu, REDACTED)
  .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gu, REDACTED)
  .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, REDACTED)
  .replace(/\bAKIA[A-Z0-9]{16}\b/gu, REDACTED)
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, `$1${REDACTED}@`)
  .replace(
    /(^|[\s,{;])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|SECRET(?:_KEY)?|SESSION_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|TOKEN|PASSWORD|PASSWD))(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&#]+)/gmu,
    (_match, prefix: string, name: string, separator: string) =>
      `${prefix}${name}${separator}${REDACTED}`,
  )
  .replace(
    /([?&](?:[a-z0-9.-]+[_-])?(?:(?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret(?:[_-]?(?:key|token))?|password|passwd|token|authorization)=)[^&#\s]*/giu,
    `$1${REDACTED}`,
  )
  .replace(
    /\b((?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|token|authorization)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&#]+)/giu,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
  );

const truncateDiagnostic = (value: string): string => value.length <= MAX_RUNTIME_DIAGNOSTIC_CHARACTERS
  ? value
  : `${value.slice(0, MAX_RUNTIME_DIAGNOSTIC_CHARACTERS - TRUNCATED.length).trimEnd()}${TRUNCATED}`;

export const runtimeDiagnostic = (error: unknown): string =>
  truncateDiagnostic(redactSecrets(normalizeDiagnostic(errorMessage(error))));

export const presentRuntimeError = (
  presentation: RuntimeErrorPresentation,
  error: unknown,
): string => {
  const diagnostic = runtimeDiagnostic(error);
  presentation.summary.textContent = "Check the local service and try again.";
  presentation.diagnostics.open = false;
  presentation.details.textContent = diagnostic;
  presentation.panel.hidden = false;
  presentation.status.textContent = "Roster couldn’t open this workspace.";
  return diagnostic;
};

export const copyRuntimeDiagnostic = async (input: {
  readonly details: TextTarget;
  readonly status: TextTarget;
  readonly writeText: (value: string) => Promise<void>;
}): Promise<void> => {
  const diagnostic = runtimeDiagnostic(input.details.textContent);
  input.details.textContent = diagnostic;
  try {
    await input.writeText(diagnostic);
    input.status.textContent = "Diagnostics copied.";
  } catch {
    input.status.textContent = "Could not copy diagnostics.";
  }
};

export const createSingleFlightAction = (
  action: () => Promise<void>,
): (() => Promise<void>) => {
  let active: Promise<void> | undefined;
  return () => {
    active ??= action().finally(() => {
      active = undefined;
    });
    return active;
  };
};
