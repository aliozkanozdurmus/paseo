import type { WorkspacePinGroup } from "@getpaseo/protocol/messages";
import { DEFAULT_WORKSPACE_PIN_GROUP_ID } from "@/stores/sidebar-view-store";

export type WorkspacePinGroupMenuActionId = "create" | "rename" | "delete";

export interface WorkspacePinGroupChoice {
  group: WorkspacePinGroup;
  selected: boolean;
}

export interface WorkspacePinGroupMenuModel {
  activeGroup: WorkspacePinGroup | null;
  choices: WorkspacePinGroupChoice[];
  actions: WorkspacePinGroupMenuActionId[];
}

export function resolveWorkspacePinGroupServerId(input: {
  connectedServerIds: readonly string[];
  supportsPinGroupsByServerId: ReadonlyMap<string, boolean>;
  activeGroupId: string;
  activeGroupServerId: string | null | undefined;
  activeWorkspaceServerId: string | null | undefined;
  hostFilters: readonly string[];
}): string | null {
  const capableServerIds = input.connectedServerIds.filter(
    (serverId) => input.supportsPinGroupsByServerId.get(serverId) === true,
  );
  if (input.activeGroupId !== DEFAULT_WORKSPACE_PIN_GROUP_ID) {
    return input.activeGroupServerId && capableServerIds.includes(input.activeGroupServerId)
      ? input.activeGroupServerId
      : null;
  }
  if (input.activeWorkspaceServerId && capableServerIds.includes(input.activeWorkspaceServerId)) {
    return input.activeWorkspaceServerId;
  }
  const filteredServerId = input.hostFilters.length === 1 ? input.hostFilters[0] : null;
  if (filteredServerId && capableServerIds.includes(filteredServerId)) {
    return filteredServerId;
  }
  if (capableServerIds.length === 1) {
    return capableServerIds[0] ?? null;
  }
  return [...capableServerIds].sort().at(0) ?? null;
}

export function canWorkspaceUseActivePinGroup(input: {
  workspaceServerId: string | null | undefined;
  supportsPinGroups: boolean;
  supportsLegacyPinning: boolean;
  activeGroupId: string;
  activeGroupServerId: string | null | undefined;
}): boolean {
  if (input.activeGroupId === DEFAULT_WORKSPACE_PIN_GROUP_ID) {
    return input.supportsPinGroups || input.supportsLegacyPinning;
  }
  return (
    input.supportsPinGroups &&
    input.workspaceServerId != null &&
    input.workspaceServerId === input.activeGroupServerId
  );
}

export function buildWorkspacePinGroupMenuModel(input: {
  groups: readonly WorkspacePinGroup[];
  activeGroupId: string;
}): WorkspacePinGroupMenuModel {
  const activeGroup = input.groups.find((group) => group.id === input.activeGroupId) ?? null;
  const actions: WorkspacePinGroupMenuActionId[] = ["create"];
  if (activeGroup && activeGroup.id !== DEFAULT_WORKSPACE_PIN_GROUP_ID) {
    actions.push("rename", "delete");
  }
  return {
    activeGroup,
    choices: input.groups.map((group) => ({
      group,
      selected: group.id === input.activeGroupId,
    })),
    actions,
  };
}

export function isWorkspacePinnedInGroup(input: {
  pinGroupId: string | null | undefined;
  activeGroupId: string;
}): boolean {
  return input.pinGroupId === input.activeGroupId;
}

export interface WorkspacePinMutationPlan {
  groupId: string | null;
}

export function planWorkspacePinMutation(input: {
  pinGroupId: string | null | undefined;
  activeGroupId: string;
}): WorkspacePinMutationPlan {
  return {
    groupId: isWorkspacePinnedInGroup(input) ? null : input.activeGroupId,
  };
}
