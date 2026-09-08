import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Native unit tests do not launch or package the staged runtime sidecar.
// Override only this test process; release builds retain their bundle checks.
const result = spawnSync("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [], resources: [] } }),
  },
  stdio: "inherit",
});

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
