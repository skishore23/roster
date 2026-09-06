/**
 * Applies the process boundary used by local Roster products.
 *
 * Local coding runtimes authenticate through their own installed CLIs. Direct
 * provider credentials must not leak into the shared server merely because the
 * launching shell happens to export them.
 */
export const applyRosterLocalOnlyEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  env.ROSTER_CODING_LOCAL_ONLY = "1";
  // Keep explicit blanks so the server's later dotenv/config import cannot
  // repopulate direct API settings from a repository .env file.
  env.OPENAI_API_KEY = "";
  env.OPENAI_MODEL = "";
  return env;
};
