# Roster runtime sidecar

Production builds place the packaged local runtime here using:

```bash
ROSTER_SIDECAR_BIN=/absolute/path/to/roster-runtime npm run sidecar:stage
```

The staging script derives Tauri's target-triple filename and rejects PATH
lookups. Generated executables are intentionally ignored by Git.

The renderer may only spawn `binaries/roster-runtime`; arbitrary shell commands
are not in its capability set. The sidecar must validate every workspace path
and every versioned request received over stdin because renderer input is
untrusted.

