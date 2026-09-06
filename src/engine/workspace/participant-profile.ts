import type { JsonValue, WorkspaceNode } from "../orchestration/types.js";

export const MAX_PARTICIPANT_PROFILE_SKILLS = 32;
export const MAX_PARTICIPANT_PROFILE_CAPABILITIES = 32;

export type WorkspaceParticipantProfile = {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly displayName: string;
  readonly role: string;
  readonly bio: string;
  readonly skills: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  readonly revision: number;
  readonly updatedAt?: number;
};

const normalizedText = (value: string, label: string, maxLength: number): string => {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (normalized.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters`);
  return normalized;
};

const normalizedList = (
  values: ReadonlyArray<string>,
  label: string,
  maxItems: number,
): ReadonlyArray<string> => {
  if (values.length > maxItems) throw new Error(`${label} must not exceed ${maxItems} items`);
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizedText(value, `${label} item`, 120);
    if (!unique.has(normalized.toLocaleLowerCase())) unique.set(normalized.toLocaleLowerCase(), normalized);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
};

export const normalizeWorkspaceParticipantProfile = (
  profile: WorkspaceParticipantProfile,
): WorkspaceParticipantProfile => ({
  ...profile,
  workspaceId: normalizedText(profile.workspaceId, "Participant profile workspace id", 160),
  nodeId: normalizedText(profile.nodeId, "Participant profile node id", 160),
  displayName: normalizedText(profile.displayName, "Participant profile display name", 80),
  role: normalizedText(profile.role, "Participant profile role", 120),
  bio: profile.bio.trim().replace(/\s+/g, " ").slice(0, 1_000),
  skills: normalizedList(profile.skills, "Participant profile skills", MAX_PARTICIPANT_PROFILE_SKILLS),
  capabilities: normalizedList(
    profile.capabilities,
    "Participant profile capabilities",
    MAX_PARTICIPANT_PROFILE_CAPABILITIES,
  ),
  revision: Math.max(0, Math.trunc(profile.revision)),
});

export const workspaceParticipantProfileFromRow = (row: {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly displayName: string;
  readonly role: string;
  readonly bio: string;
  readonly skillsJson: string;
  readonly capabilitiesJson: string;
  readonly revision: bigint | number;
  readonly updatedAt?: { readonly microsSinceUnixEpoch: bigint };
}): WorkspaceParticipantProfile | undefined => {
  try {
    const skills = JSON.parse(row.skillsJson) as unknown;
    const capabilities = JSON.parse(row.capabilitiesJson) as unknown;
    if (!Array.isArray(skills) || !skills.every((value) => typeof value === "string")) return undefined;
    if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) return undefined;
    return normalizeWorkspaceParticipantProfile({
      workspaceId: row.workspaceId,
      nodeId: row.nodeId,
      displayName: row.displayName,
      role: row.role,
      bio: row.bio,
      skills,
      capabilities,
      revision: Number(row.revision),
      ...(row.updatedAt ? { updatedAt: Number(row.updatedAt.microsSinceUnixEpoch / 1_000n) } : {}),
    });
  } catch {
    return undefined;
  }
};

const skillName = (skill: JsonValue): string | undefined => {
  if (typeof skill === "string") return skill.trim() || undefined;
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return undefined;
  const name = (skill as Readonly<Record<string, JsonValue>>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
};

/**
 * Applies the latest workspace-owned social profile to a logical node before a
 * new execution is snapshotted. Historical node snapshots and runtime bindings
 * remain unchanged.
 */
export const applyWorkspaceParticipantProfile = (
  node: WorkspaceNode,
  profile: WorkspaceParticipantProfile | undefined,
  allowedCapabilities?: ReadonlySet<string>,
): WorkspaceNode => {
  if (!profile || profile.nodeId !== node.id) return node;
  const normalized = normalizeWorkspaceParticipantProfile(profile);
  const capabilities = normalized.capabilities.filter((capability) =>
    !allowedCapabilities || allowedCapabilities.has(capability));
  const learnedSkills = Array.isArray(node.metadata?.specialistSkills)
    ? node.metadata.specialistSkills.filter((skill): skill is JsonValue => skillName(skill) !== undefined)
    : [];
  const learnedNames = new Set(learnedSkills.flatMap((skill) => {
    const name = skillName(skill);
    return name ? [name.toLocaleLowerCase()] : [];
  }));
  const profileSkills = normalized.skills.filter((skill) => !learnedNames.has(skill.toLocaleLowerCase()));
  return {
    ...node,
    capabilities: capabilities.length > 0 ? capabilities : node.capabilities,
    metadata: {
      ...(node.metadata ?? {}),
      givenName: normalized.displayName,
      displayRole: normalized.role,
      profileBio: normalized.bio,
      profileSkills: normalized.skills,
      specialistSkills: [...learnedSkills, ...profileSkills],
      profileRevision: normalized.revision,
    },
  };
};

export const applyWorkspaceParticipantProfiles = (
  nodes: ReadonlyArray<WorkspaceNode>,
  profiles: ReadonlyArray<WorkspaceParticipantProfile>,
  allowedCapabilities?: ReadonlySet<string>,
): ReadonlyArray<WorkspaceNode> => {
  const byNode = new Map(profiles.map((profile) => [profile.nodeId, profile]));
  return nodes.map((node) =>
    applyWorkspaceParticipantProfile(node, byNode.get(node.id), allowedCapabilities));
};
