type AvailableRuntime = {
  readonly id: string;
  readonly readiness: string;
  readonly executablePath?: string;
};

export const selectDiscoveredRuntimes = (
  runtimes: readonly AvailableRuntime[],
  saved?: { readonly runtimeIds: readonly string[]; readonly defaultRuntimeId: string },
): { readonly runtimeIds: readonly string[]; readonly defaultRuntimeId?: string; readonly canAutoResume: boolean } => {
  const runtimeIds = runtimes.filter((runtime) => runtime.readiness === "ready" && runtime.executablePath
    && (!saved || saved.runtimeIds.includes(runtime.id))).map((runtime) => runtime.id);
  const defaultRuntimeId = saved
    ? (runtimeIds.includes(saved.defaultRuntimeId) ? saved.defaultRuntimeId : undefined)
    : ["pi-agent", "codex-cli", "claude-code", "hermes-agent"].find((id) => runtimeIds.includes(id));
  return {
    runtimeIds,
    defaultRuntimeId,
    canAutoResume: Boolean(saved && defaultRuntimeId && saved.runtimeIds.every((id) => runtimeIds.includes(id))),
  };
};
