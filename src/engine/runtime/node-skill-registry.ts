import type { WorkspaceNodeRuntimeKind } from "../orchestration/types.js";
import {
  createNodeExecutionSkill,
  MAX_NODE_EXECUTION_SKILLS,
  type NodeExecutionSkill,
} from "./node-runtime.js";

export type NodeExecutionSkillSelectionContext = {
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeCapabilities: ReadonlyArray<string>;
  readonly taskId: string;
  readonly capability: string;
  readonly handlerKind: string;
  readonly effectiveRuntimeKind: WorkspaceNodeRuntimeKind;
};

export type NodeExecutionSkillSelector = (
  context: NodeExecutionSkillSelectionContext,
) => ReadonlyArray<string>;

/**
 * Immutable provider-neutral skill catalog. Selection remains a platform
 * policy decision; runtimes receive only the exact content-addressed skills
 * chosen for one bounded task.
 */
export class NodeExecutionSkillRegistry {
  readonly #skills: ReadonlyMap<string, NodeExecutionSkill>;

  constructor(skills: ReadonlyArray<NodeExecutionSkill> = []) {
    const registered = new Map<string, NodeExecutionSkill>();
    for (const candidate of skills) {
      const skill = Object.freeze(createNodeExecutionSkill(candidate));
      if (registered.has(skill.id)) {
        throw new Error(`Duplicate node execution skill ${skill.id}`);
      }
      registered.set(skill.id, skill);
    }
    this.#skills = registered;
  }

  skill(skillId: string): NodeExecutionSkill {
    const normalized = skillId.trim();
    const skill = this.#skills.get(normalized);
    if (!skill) throw new Error(`Unknown node execution skill ${normalized || skillId}`);
    return skill;
  }

  select(skillIds: ReadonlyArray<string>): ReadonlyArray<NodeExecutionSkill> {
    if (skillIds.length > MAX_NODE_EXECUTION_SKILLS) {
      throw new Error(
        `A node execution may select at most ${MAX_NODE_EXECUTION_SKILLS} skills`,
      );
    }
    const selectedIds = skillIds.map((skillId) => skillId.trim());
    if (selectedIds.some((skillId) => !skillId)) {
      throw new Error("Node execution skill selections must not contain blank IDs");
    }
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new Error("Node execution skill selections must not contain duplicate IDs");
    }
    return Object.freeze(selectedIds.map((skillId) => this.skill(skillId)));
  }

  entries(): ReadonlyArray<NodeExecutionSkill> {
    return Object.freeze([...this.#skills.values()]);
  }
}
