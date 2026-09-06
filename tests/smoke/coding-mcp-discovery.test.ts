import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverCodingMcpConfiguration,
} from "../../src/engine/runtime/coding-mcp-discovery.ts";

test("Codex MCP discovery returns bounded metadata without commands, URLs, or secrets", async () => {
  const servers = Array.from({ length: 70 }, (_, index) => ({
    name: index === 0 ? "\u0000invalid" : `server-${String(index).padStart(2, "0")}`,
    enabled: index !== 2,
    auth_status: "Bearer secret-must-not-project",
    transport: index % 2 === 0
      ? { type: "stdio", command: "secret-command", env: { TOKEN: "secret-token" } }
      : { type: "streamable_http", url: "https://secret.example/mcp", http_headers: { Authorization: "secret" } },
  }));
  const discovery = await discoverCodingMcpConfiguration({
    runtimeId: "codex-cli",
    runtimeAvailable: true,
    executablePath: "/opt/codex",
    workingDirectory: "/workspace",
    homeDirectory: "/home/tester",
    env: { PATH: "/opt", SECRET_FROM_PARENT: "must-not-reach-probe" },
    run: async (executable, args, options) => {
      assert.equal(executable, "/opt/codex");
      assert.deepEqual(args, ["mcp", "list", "--json"]);
      assert.equal(options.env.SECRET_FROM_PARENT, undefined);
      return { stdout: JSON.stringify(servers), stderr: "" };
    },
  });

  assert.equal(discovery.mode, "native");
  assert.equal(discovery.readiness, "discovered");
  assert.equal(discovery.servers.length, 64);
  assert.equal(discovery.truncated, true);
  assert.equal(discovery.servers.find((server) => server.name === "server-02")?.status, "disabled");
  assert.equal(discovery.servers.find((server) => server.name === "server-01")?.transport, "http");
  const projection = JSON.stringify(discovery);
  assert.doesNotMatch(projection, /secret|Authorization|command|url/u);
});

test("Claude MCP discovery merges user, local, and approved workspace configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-claude-mcp-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    await writeFile(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        global: { command: "global-command", env: { TOKEN: "global-secret" } },
      },
      projects: {
        [workspace]: {
          mcpServers: {
            local: { type: "sse", url: "https://local.example/sse" },
          },
          enabledMcpjsonServers: ["approved"],
          disabledMcpjsonServers: ["disabled"],
        },
      },
    }));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({
      mcpServers: {
        approved: { type: "http", url: "https://approved.example/mcp" },
        disabled: { command: "disabled-command" },
        pending: { command: "pending-command", env: { KEY: "pending-secret" } },
      },
    }));

    const discovery = await discoverCodingMcpConfiguration({
      runtimeId: "claude-code",
      runtimeAvailable: true,
      executablePath: "/opt/claude",
      workingDirectory: workspace,
      homeDirectory: home,
    });
    assert.equal(discovery.readiness, "discovered");
    assert.deepEqual(discovery.servers.map((server) => ({
      name: server.name,
      source: server.source,
      status: server.status,
      transport: server.transport,
    })), [
      { name: "approved", source: "workspace", status: "enabled", transport: "http" },
      { name: "disabled", source: "workspace", status: "disabled", transport: "stdio" },
      { name: "global", source: "user", status: "enabled", transport: "stdio" },
      { name: "local", source: "workspace", status: "enabled", transport: "sse" },
      { name: "pending", source: "workspace", status: "pending-approval", transport: "stdio" },
    ]);
    assert.doesNotMatch(JSON.stringify(discovery), /secret|example|command/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hermes MCP discovery parses local configuration listing without testing connections", async () => {
  const discovery = await discoverCodingMcpConfiguration({
    runtimeId: "hermes-agent",
    runtimeAvailable: true,
    executablePath: "/opt/hermes",
    run: async (_executable, args) => {
      assert.deepEqual(args, ["mcp", "list"]);
      return {
        stdout: [
          "",
          "  MCP Servers:",
          "",
          "  Name             Transport                      Tools        Status",
          "  ──────────────── ────────────────────────────── ──────────── ──────────",
          "  docs             https://docs.example/mcp       all          ✓ enabled",
          "  local-tools      node server.js                 2 selected   ✗ disabled",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
  });
  assert.deepEqual(discovery.servers, [
    { name: "docs", transport: "http", status: "enabled", source: "runtime" },
    { name: "local-tools", transport: "stdio", status: "disabled", source: "runtime" },
  ]);
});

test("MCP discovery fails closed without making runtime discovery fail", async () => {
  const failed = await discoverCodingMcpConfiguration({
    runtimeId: "codex-cli",
    runtimeAvailable: true,
    executablePath: "/opt/codex",
    run: async () => { throw new Error("probe exploded with secret detail"); },
  });
  assert.deepEqual(failed, {
    mode: "native",
    readiness: "probe-failed",
    servers: [],
    truncated: false,
  });
  assert.equal((await discoverCodingMcpConfiguration({
    runtimeId: "pi-agent",
    runtimeAvailable: true,
  })).readiness, "extension-managed");
  assert.equal((await discoverCodingMcpConfiguration({
    runtimeId: "custom-runtime",
    runtimeAvailable: true,
  })).readiness, "not-supported");
  assert.equal((await discoverCodingMcpConfiguration({
    runtimeId: "claude-code",
    runtimeAvailable: false,
  })).readiness, "runtime-unavailable");
});
