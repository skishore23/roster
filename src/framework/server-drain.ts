const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const serverDrainAllowsRequest = (method: string): boolean =>
  READ_ONLY_METHODS.has(method.trim().toUpperCase());

export type ServerDrainOptions = {
  readonly stopWorker: () => void;
  readonly stopHeartbeats: () => void;
  readonly drainWorker: () => Promise<void>;
  readonly closeHttp: () => Promise<void>;
  readonly closeResources: () => Promise<void> | void;
  readonly onError?: (phase: "worker" | "http" | "resources", error: unknown) => void;
};

/**
 * Stops new background work immediately, but keeps the HTTP projection alive
 * until every already-leased handler settles. This preserves access to the
 * process-local diagnostics owned by the draining server.
 */
export const drainServer = async (options: ServerDrainOptions): Promise<void> => {
  options.stopWorker();
  options.stopHeartbeats();

  try {
    await options.drainWorker();
  } catch (error) {
    options.onError?.("worker", error);
  }

  try {
    await options.closeHttp();
  } catch (error) {
    options.onError?.("http", error);
  }
  try {
    await options.closeResources();
  } catch (error) {
    options.onError?.("resources", error);
  }
};
