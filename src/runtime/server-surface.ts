export type RosterServerSurface = "full" | "repository";

const REPOSITORY_ASSET_PATHS = new Set([
  "/assets/coding-client.js",
  "/assets/coding-enhancements.js",
  "/assets/coding-mermaid-renderer.js",
  "/assets/roster-shell.js",
]);

export const resolveRosterServerSurface = (
  env: NodeJS.ProcessEnv = process.env,
): RosterServerSurface => {
  const configured = env.ROSTER_SERVER_SURFACE?.trim();
  if (!configured) return "full";
  if (configured === "full" || configured === "repository") return configured;
  throw new Error(`Unsupported Roster server surface "${configured}"`);
};

export const serverSurfaceAllowsPath = (
  surface: RosterServerSurface,
  pathname: string,
): boolean => {
  if (surface === "full") return true;
  if (pathname === "/" || pathname === "/auth" || pathname === "/healthz" || pathname === "/readyz") return true;
  if (pathname === "/coding" || pathname.startsWith("/coding/")) return true;
  if (pathname === "/api/v2/coding" || pathname.startsWith("/api/v2/coding/")) return true;
  return REPOSITORY_ASSET_PATHS.has(pathname);
};

export const serverSurfaceAgentModuleNames = (
  surface: RosterServerSurface,
): ReadonlyArray<string> | undefined => surface === "repository" ? ["coding"] : undefined;

export const selectServerSurfaceJobHandlers = <T>(
  surface: RosterServerSurface,
  handlers: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> => {
  if (surface === "full") return handlers;
  const codingHandler = handlers["coding-agent"];
  if (!codingHandler) throw new Error("Repository server surface requires the coding-agent job handler");
  return { "coding-agent": codingHandler };
};
