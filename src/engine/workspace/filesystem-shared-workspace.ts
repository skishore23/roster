import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { hashCanonical } from "../../core/canonical.js";
import type { DynamicTaskHandlerContext } from "../orchestration/task-graph.js";
import { taskGraphTask, type TaskGraphControl } from "../orchestration/task-graph-control.js";
import type { DynamicTaskDefinition } from "../platform/protocol.js";
import type { RosterTaskContextFactory } from "../platform/roster-platform.js";
import type { WorkspaceNode } from "../orchestration/types.js";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
  type RosterTaskContext,
  type TaskWorkspaceAuthority,
  type TaskWorkspaceFence,
} from "./shared-workspace.js";

const SAFE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

const missingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Durable local adapter for the bounded shared-workspace CRDT.
 *
 * The ledger remains the convergence authority. This adapter only persists its
 * complete encoded state with atomic replacement, allowing a restarted worker
 * to recover the same frontier before a task is given a context.
 */
export class FileSystemSharedWorkspace {
  readonly durability = "durable" as const;
  readonly artifactId: string;
  readonly statePath: string;

  private ledger?: SharedWorkspaceLedger;
  private initializePromise?: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();
  private writeOrdinal = 0;

  constructor(input: {
    readonly directory: string;
    readonly namespace: string;
    readonly artifactId?: string;
  }) {
    const directory = resolve(input.directory.trim());
    const namespace = input.namespace.trim();
    if (!input.directory.trim() || !isAbsolute(directory)) {
      throw new Error("Filesystem shared-workspace directory must be absolute");
    }
    if (!SAFE_NAMESPACE.test(namespace)) {
      throw new Error("Filesystem shared-workspace namespace is invalid");
    }
    this.artifactId = input.artifactId?.trim() || `workspace_${hashCanonical(namespace).slice(0, 28)}`;
    this.statePath = join(directory, `${hashCanonical(namespace).slice(0, 40)}.yjs`);
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
        let encoded: Uint8Array | undefined;
        try {
          encoded = await readFile(this.statePath);
        } catch (error) {
          if (!missingFile(error)) throw error;
        }
        this.ledger = new SharedWorkspaceLedger(this.artifactId, encoded);
      })().catch((error: unknown) => {
        this.initializePromise = undefined;
        throw error;
      });
    }
    await this.initializePromise;
  }

  async createTaskContext(input: {
    readonly node: WorkspaceNode;
    readonly fence: TaskWorkspaceFence;
    readonly authority: TaskWorkspaceAuthority;
  }): Promise<RosterTaskContext> {
    await this.initialize();
    return createRosterTaskContext({
      node: input.node,
      ledger: this.ledger!,
      fence: input.fence,
      authority: input.authority,
      onUpdate: () => this.persist(),
    });
  }

  async flush(): Promise<void> {
    await this.persistTail;
  }

  close(): void {
    this.ledger?.destroy();
    this.ledger = undefined;
    this.initializePromise = undefined;
  }

  private persist(): Promise<void> {
    const pending = this.persistTail.then(async () => {
      const ledger = this.ledger;
      if (!ledger) throw new Error("Filesystem shared workspace is not initialized");
      const encoded = ledger.encode();
      this.writeOrdinal += 1;
      const temporary = `${this.statePath}.${process.pid}.${this.writeOrdinal}.tmp`;
      await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.persistTail = pending.catch(() => undefined);
    return pending;
  }
}

export const createTaskGraphWorkspaceContextFactory = (input: {
  readonly taskGraph: TaskGraphControl;
  readonly workspace: FileSystemSharedWorkspace;
}): RosterTaskContextFactory =>
  Object.assign(async ({ runId, node, definition, lease }: {
    readonly runId: string;
    readonly node: WorkspaceNode;
    readonly definition: DynamicTaskDefinition;
    readonly lease: DynamicTaskHandlerContext["lease"];
  }) => input.workspace.createTaskContext({
    node,
    fence: {
      runId,
      taskId: definition.taskId,
      nodeId: node.id,
      fence: BigInt(lease.fence),
      frontierVersion: definition.inputs.frontierVersion,
      topologyVersion: definition.inputs.topologyVersion,
      catalogVersion: definition.inputs.catalogVersion,
      runtimeBindingEpoch: definition.runtimeBindingEpoch,
      inputVersions: definition.inputs.inputVersions,
    },
    authority: {
      assertActive: async () => {
        const record = taskGraphTask(await input.taskGraph.snapshot(), definition.taskId);
        if (
          !record
          || (record.status !== "leased" && record.status !== "running")
          || (record.leaseOwner !== undefined && record.leaseOwner !== lease.owner)
          || record.leaseFence !== lease.fence
        ) {
          throw new Error(`Roster task ${definition.taskId} no longer owns its shared-workspace fence`);
        }
      },
    },
  }), { durability: input.workspace.durability });
