import { readFileSync } from "node:fs";

import {
  createNodeExecutionSkill,
  type NodeExecutionSkill,
} from "../engine/runtime/node-runtime.js";

const skillDocument = readFileSync(
  new URL("../../prompts/skills/roster-coordination/SKILL.md", import.meta.url),
  "utf8",
);

const skillLines = skillDocument.split("\n");
if (skillLines[0]?.trim() !== "---") {
  throw new Error("The bundled Roster coordination skill is missing frontmatter");
}
const frontmatterEnd = skillLines.findIndex((line, index) => index > 0 && line.trim() === "---");
if (frontmatterEnd < 2) {
  throw new Error("The bundled Roster coordination skill has incomplete frontmatter");
}

const frontmatterValue = (key: string): string | undefined => {
  const prefix = `${key}:`;
  const line = skillLines.slice(1, frontmatterEnd).find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value || undefined;
};

export const CODING_COORDINATION_SKILL: NodeExecutionSkill = createNodeExecutionSkill({
  id: "roster-coordination",
  name: frontmatterValue("name") ?? "",
  description: frontmatterValue("description") ?? "",
  instructions: skillLines.slice(frontmatterEnd + 1).join("\n"),
});
