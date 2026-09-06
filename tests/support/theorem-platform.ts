import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../../src/engine/workspace/shared-workspace.ts";
import type { TheoremPlatformExecutionPlaneFactory } from "../../src/agents/theorem.platform.ts";

/**
 * Tests opt into process-local execution explicitly. Production Theorem
 * callers must inject a durable execution-plane factory.
 */
export const createTestTheoremExecutionPlanes: TheoremPlatformExecutionPlaneFactory = (
  scope,
) => {
  const taskGraph = new InMemoryTaskGraphControl();
  const ledger = new SharedWorkspaceLedger(`theorem-test:${scope.runId}`);
  return {
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore(),
    createTaskContext: ({ runId, node, definition, lease }) =>
      createRosterTaskContext({
        node,
        ledger,
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
            const record = taskGraphTask(await taskGraph.snapshot(), definition.taskId);
            if (
              !record
              || (record.status !== "leased" && record.status !== "running")
              || record.leaseOwner !== lease.owner
              || record.leaseFence !== lease.fence
            ) {
              throw new Error(`Theorem test task ${definition.taskId} lost its workspace fence`);
            }
          },
        },
      }),
  };
};
