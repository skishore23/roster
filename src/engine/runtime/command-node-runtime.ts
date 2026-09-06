import { spawn, spawnSync } from "node:child_process";

import { startProcessRssGuard } from "./process-rss-guard.js";
import {
  bindPreparedNodeRuntimeExecutor,
  isNodeExecutionResult,
  type NodeExecutionEnvelope,
  type NodeExecutionLog,
  type NodeExecutionResult,
  type NodeRuntimeExecutionControl,
  type NodeRuntimeAdapter,
} from "./node-runtime.js";
import type { WorkspaceNodeRuntimeKind } from "../orchestration/types.js";

export type CommandExecution = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string;
  readonly cwd?: string;
  /** Trusted process environment additions. These are never serialized into the node envelope. */
  readonly env?: NodeJS.ProcessEnv;
  /** Use env as the complete child environment instead of inheriting the parent. */
  readonly replaceEnvironment?: boolean;
  readonly signal?: AbortSignal;
  /** Optional hard process timeout. Existing callers remain signal-controlled by default. */
  readonly timeoutMs?: number;
  /**
   * Hard resident-memory ceiling across the child process tree. Defaults to
   * DEFAULT_COMMAND_MAX_RSS_BYTES (ROSTER_NODE_COMMAND_MAX_RSS_BYTES overrides
   * the default) so a runaway workload dies before the host does.
   */
  readonly maxRssBytes?: number;
  /** Hard ceiling for chargeable stdout/stderr output. */
  readonly maxOutputBytes: number;
  /**
   * Hard ceiling across the raw stdout/stderr transport. Defaults to
   * maxOutputBytes. Structured streaming runtimes may set this separately
   * when their protocol repeats an accumulating snapshot on every delta.
   */
  readonly maxTransportBytes?: number;
  /** Bytes retained for result parsing and failure diagnostics. Defaults to the hard ceiling. */
  readonly maxCaptureBytes?: number;
  /**
   * Returns the bytes charged to maxOutputBytes for one raw chunk. The raw
   * chunk always remains subject to maxTransportBytes.
   */
  readonly outputBudgetBytes?: (entry: NodeExecutionLog) => number;
  readonly onOutput?: (entry: NodeExecutionLog) => void;
};

export type CommandExecutionResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
};

export type CommandRunner = (execution: CommandExecution) => Promise<CommandExecutionResult>;

export const DEFAULT_COMMAND_MAX_RSS_BYTES = 8 * 1024 * 1024 * 1024;

const defaultMaxRssBytes = (): number => {
  const configured = Number(process.env.ROSTER_NODE_COMMAND_MAX_RSS_BYTES ?? "");
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_COMMAND_MAX_RSS_BYTES;
};

const PROCESS_TERMINATION_GRACE_MS = 2_000;
const PROCESS_FORCE_KILL_SETTLE_MS = 250;
const PROCESS_EXIT_POLL_MS = 25;

const descendantProcessIds = (rootPid: number): number[] => {
  if (process.platform === "win32") return [];
  const listed = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of listed.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants.reverse();
};

export const runCommand: CommandRunner = (execution) => new Promise((resolve, reject) => {
  if (execution.signal?.aborted) {
    reject(execution.signal.reason instanceof Error
      ? execution.signal.reason
      : new Error("Node command was aborted before launch"));
    return;
  }
  if (execution.timeoutMs !== undefined
    && (!Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs < 1)) {
    reject(new Error("Node command timeoutMs must be a positive safe integer"));
    return;
  }
  if (execution.maxRssBytes !== undefined
    && (!Number.isSafeInteger(execution.maxRssBytes) || execution.maxRssBytes < 1)) {
    reject(new Error("Node command maxRssBytes must be a positive safe integer"));
    return;
  }
  // Deliberately avoid a shell: every argument keeps its literal meaning.
  // On POSIX, a dedicated process group lets cancellation reach tools that
  // launch their own subprocesses (for example an agent running npm verify).
  const grouped = process.platform !== "win32";
  const child = spawn(execution.command, [...execution.args], {
    shell: false,
    cwd: execution.cwd,
    env: execution.replaceEnvironment
      ? { ...execution.env }
      : execution.env ? { ...process.env, ...execution.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: grouped,
  });
  let terminalError: Error | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let terminationStartedAt: number | undefined;
  let processTreeSettlement: Promise<void> | undefined;
  const knownDescendants = new Set<number>();
  const killProcessTree = (signal: NodeJS.Signals): void => {
    if (child.pid) {
      for (const pid of descendantProcessIds(child.pid)) knownDescendants.add(pid);
    }
    if (grouped && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.kill(signal);
        }
      }
    } else {
      child.kill(signal);
    }
    // Some tools deliberately create their own process groups. Signal every
    // descendant captured before the group leader exits so those subprocesses
    // cannot outlive cancellation and race isolated-worktree cleanup.
    for (const pid of knownDescendants) {
      try {
        process.kill(pid, signal);
      } catch {
        // Cancellation is best-effort for descendants we no longer own. Keep
        // the root command's original terminal error authoritative.
      }
    }
  };
  const processExists = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const processTreeExists = (): boolean => {
    if (grouped && child.pid && processExists(-child.pid)) return true;
    return [...knownDescendants].some(processExists);
  };
  const waitForProcessTreeExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (processTreeExists()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, Math.min(PROCESS_EXIT_POLL_MS, remaining));
      });
    }
    return true;
  };
  const beginTermination = (): void => {
    terminationStartedAt ??= Date.now();
    killProcessTree("SIGTERM");
  };
  const settleProcessTree = async (): Promise<void> => {
    beginTermination();
    const startedAt = terminationStartedAt ?? Date.now();
    const gracefulRemaining = Math.max(
      0,
      PROCESS_TERMINATION_GRACE_MS - (Date.now() - startedAt),
    );
    if (await waitForProcessTreeExit(gracefulRemaining)) return;
    killProcessTree("SIGKILL");
    await waitForProcessTreeExit(PROCESS_FORCE_KILL_SETTLE_MS);
  };
  const startProcessTreeSettlement = (): Promise<void> => {
    processTreeSettlement ??= settleProcessTree();
    return processTreeSettlement;
  };
  const fail = (error: Error): void => {
    if (terminalError) return;
    terminalError = error;
    beginTermination();
    forceKillTimer = setTimeout(() => killProcessTree("SIGKILL"), PROCESS_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };
  const onAbort = (): void => fail(execution.signal?.reason instanceof Error
    ? execution.signal.reason
    : new Error("Node command was aborted"));
  if (execution.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(
      () => fail(new Error(`Node command exceeded timeoutMs=${execution.timeoutMs}`)),
      execution.timeoutMs,
    );
    timeoutTimer.unref();
  }
  execution.signal?.addEventListener("abort", onAbort, { once: true });
  const maxRssBytes = execution.maxRssBytes ?? defaultMaxRssBytes();
  const rssGuard = child.pid === undefined ? undefined : startProcessRssGuard({
    rootPid: child.pid,
    maxRssBytes,
    onExceeded: (rssBytes) => fail(new Error(
      `Node command exceeded maxRssBytes=${maxRssBytes} with resident bytes=${rssBytes}`,
    )),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const emitOutput = (entry: NodeExecutionLog): void => {
    try {
      execution.onOutput?.(entry);
    } catch {
      // Diagnostics must not become execution authority or crash the worker.
    }
  };
  let outputBytes = 0;
  let transportBytes = 0;
  const maxTransportBytes = Math.max(
    execution.maxOutputBytes,
    execution.maxTransportBytes ?? execution.maxOutputBytes,
  );
  const maxCaptureBytes = Math.max(1_024, Math.min(
    execution.maxOutputBytes,
    execution.maxCaptureBytes ?? execution.maxOutputBytes,
  ));
  const appendTail = (target: Buffer[], chunk: Buffer): boolean => {
    let truncated = false;
    target.push(chunk);
    let retainedBytes = target.reduce((total, value) => total + value.byteLength, 0);
    while (retainedBytes > maxCaptureBytes && target.length > 0) {
      truncated = true;
      const overflow = retainedBytes - maxCaptureBytes;
      const first = target[0]!;
      if (first.byteLength <= overflow) {
        target.shift();
        retainedBytes -= first.byteLength;
        continue;
      }
      target[0] = first.subarray(overflow);
      retainedBytes -= overflow;
    }
    return truncated;
  };
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const collect = (
    target: Buffer[],
    chunk: Buffer,
    entry: NodeExecutionLog,
    stream: "stdout" | "stderr",
  ): void => {
    transportBytes += chunk.byteLength;
    if (transportBytes > maxTransportBytes) {
      fail(new Error(`Node command exceeded maxTransportBytes=${maxTransportBytes}`));
      return;
    }
    let budgetBytes: number;
    try {
      budgetBytes = execution.outputBudgetBytes?.(entry) ?? chunk.byteLength;
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
      fail(new Error("Node command output budget returned an invalid byte count"));
      return;
    }
    outputBytes += budgetBytes;
    if (outputBytes > execution.maxOutputBytes) {
      fail(new Error(`Node command exceeded maxOutputBytes=${execution.maxOutputBytes}`));
      return;
    }
    const truncated = appendTail(target, chunk);
    if (stream === "stdout") stdoutTruncated ||= truncated;
    else stderrTruncated ||= truncated;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    const entry = { stream: "stdout" as const, text: chunk.toString("utf8") };
    emitOutput(entry);
    collect(stdout, chunk, entry, "stdout");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const entry = { stream: "stderr" as const, text: chunk.toString("utf8") };
    emitOutput(entry);
    collect(stderr, chunk, entry, "stderr");
  });
  child.stdin.once("error", (error: NodeJS.ErrnoException) => {
    // A fast command can close stdin before Node finishes an empty end().
    // There were no input bytes to lose, so that EPIPE is not an execution
    // failure. Non-empty input must still fail closed if it was not delivered.
    if (error.code === "EPIPE" && execution.stdin.length === 0) return;
    fail(error);
  });
  child.once("error", (error) => fail(error));
  // A descendant may inherit these stdout/stderr pipes and keep `close` from
  // firing after the root exits. Start cleanup at the root exit boundary, but
  // retain `close` below for complete output capture and final settlement.
  child.once("exit", () => void startProcessTreeSettlement());
  child.once("close", (exitCode) => {
    execution.signal?.removeEventListener("abort", onAbort);
    rssGuard?.stop();
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const result: CommandExecutionResult = {
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(stderrTruncated ? { stderrTruncated: true } : {}),
    };
    void startProcessTreeSettlement().then(() => {
      if (terminalError) reject(terminalError);
      else resolve(result);
    });
  });
  if (execution.stdin.length > 0) child.stdin.end(execution.stdin);
  else child.stdin.end();
});

export type CommandNodeRuntimeOptions = {
  readonly kind?: WorkspaceNodeRuntimeKind;
  readonly runner?: CommandRunner;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  /** Trusted additions inherited by the command worker and code-mode client. */
  readonly environment?: NodeJS.ProcessEnv;
};

/**
 * Creates a transport adapter that sends one JSON envelope on stdin and expects
 * one NodeExecutionResult JSON document on stdout. The runtime command is
 * executed directly, never via shell interpolation.
 */
export const createCommandNodeRuntimeAdapter = (
  options: CommandNodeRuntimeOptions = {},
): NodeRuntimeAdapter => {
  const kind = options.kind ?? "shell";
  const runner = options.runner ?? runCommand;
  const maxInputBytes = Math.max(1_024, options.maxInputBytes ?? 1_048_576);
  const maxOutputBytes = Math.max(1_024, options.maxOutputBytes ?? 1_048_576);
  const executeTransport = async (
    envelope: NodeExecutionEnvelope,
    control: NodeRuntimeExecutionControl,
    environment: NodeJS.ProcessEnv | undefined,
  ): Promise<NodeExecutionResult> => {
    const command = envelope.runtime.command;
    if (!command?.length) throw new Error(`Node runtime ${kind} requires a command`);
    const stdin = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(stdin) > maxInputBytes) {
      throw new Error(`Node command envelope exceeded maxInputBytes=${maxInputBytes}`);
    }
    const result = await runner({
      command: command[0],
      args: command.slice(1),
      stdin,
      env: environment,
      signal: control.signal,
      maxOutputBytes,
      onOutput: control.onLog,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
      throw new Error(`Node command exited with code ${String(result.exitCode)}: ${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Node command returned invalid JSON");
    }
    if (!isNodeExecutionResult(parsed)) {
      throw new Error("Node command returned an invalid execution result");
    }
    return parsed;
  };
  const adapter: NodeRuntimeAdapter = {
    kind,
    supportsCodeMode: true,
    validateRuntime: (runtime) => {
      if (!runtime.command?.length) throw new Error(`Node runtime ${kind} requires a command`);
    },
    executeEnvelope: (envelope, control) => {
      if (envelope.surface.codeMode) {
        throw new Error(`Node runtime ${kind} requires registry-prepared code mode`);
      }
      return executeTransport(envelope, control, options.environment);
    },
  };
  return bindPreparedNodeRuntimeExecutor(adapter, {
    environment: options.environment,
    execute: (transport, control) =>
      executeTransport(transport.envelope, control, transport.environment),
  });
};
