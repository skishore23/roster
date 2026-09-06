import { createA2ANodeRuntimeAdapter } from "./a2a-node-runtime.js";
import { createCommandNodeRuntimeAdapter } from "./command-node-runtime.js";
import {
  createClaudeCodeNodeRuntimeAdapter,
  createCodexCliNodeRuntimeAdapter,
  createHermesAgentNodeRuntimeAdapter,
  createPiAgentNodeRuntimeAdapter,
  type AgentCliTrajectoryOptions,
} from "./agent-cli-node-runtime.js";
import { resolveCodingCliEnvironment } from "./coding-cli-environment.js";
import { rosterNativeNodeRuntime, NodeRuntimeRegistry } from "./node-runtime.js";

export type StandardNodeRuntimeOptions = {
  /** Trusted additions inherited by local coding CLI processes and their tools. */
  readonly codingEnvironment?: NodeJS.ProcessEnv;
  /** Explicit additions inherited only by non-model host command workers. */
  readonly commandEnvironment?: NodeJS.ProcessEnv;
  /** Shared normalization and source-reading policy for coding CLI trajectories. */
  readonly trajectory?: AgentCliTrajectoryOptions;
};

export const standardNodeRuntimeEnvironments = (
  options: Pick<StandardNodeRuntimeOptions, "codingEnvironment" | "commandEnvironment"> = {},
): {
  readonly coding: NodeJS.ProcessEnv;
  readonly command: NodeJS.ProcessEnv;
} => {
  const coding = {
    ...options.codingEnvironment,
    ...resolveCodingCliEnvironment({ ...process.env, ...options.codingEnvironment }),
  };
  return {
    coding,
    command: {
      ...coding,
      ...options.commandEnvironment,
    },
  };
};

/** Built-in transports available to orchestration without caller-specific wiring. */
export const createStandardNodeRuntimeRegistry = (
  options: StandardNodeRuntimeOptions = {},
): NodeRuntimeRegistry => {
  const environment = standardNodeRuntimeEnvironments(options);
  return new NodeRuntimeRegistry([
    rosterNativeNodeRuntime,
    createCommandNodeRuntimeAdapter({ kind: "shell", environment: environment.command }),
    createCodexCliNodeRuntimeAdapter({ environment: environment.coding, trajectory: options.trajectory }),
    createClaudeCodeNodeRuntimeAdapter({ environment: environment.coding, trajectory: options.trajectory }),
    createPiAgentNodeRuntimeAdapter({ environment: environment.coding, trajectory: options.trajectory }),
    createHermesAgentNodeRuntimeAdapter({ environment: environment.coding, trajectory: options.trajectory }),
    createA2ANodeRuntimeAdapter(),
  ]);
};
