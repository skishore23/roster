const spacetimeUri = process.env.SPACETIMEDB_URI?.trim();
const spacetimeDatabase = process.env.SPACETIMEDB_DATABASE?.trim();

export const SPACETIMEDB_TESTS_ENABLED = Boolean(spacetimeUri && spacetimeDatabase);

const SPACETIMEDB_TEST_SKIP_REASON = [
  "requires SPACETIMEDB_URI and SPACETIMEDB_DATABASE",
  "run `npm run verify` to execute it against the isolated verification control plane",
].join("; ");

export const spacetimeTestOptions = (timeout: number): {
  readonly timeout: number;
  readonly skip: false | string;
} => ({
  timeout,
  skip: SPACETIMEDB_TESTS_ENABLED ? false : SPACETIMEDB_TEST_SKIP_REASON,
});
