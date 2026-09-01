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
  pinnedAt: string | null | undefined;
  pinGroupId: string | null | undefined;
  activeGroupId: string;
  supportsPinGroups: boolean;
}): boolean {
  if (!input.supportsPinGroups) {
    return input.pinnedAt != null;
  }
  return input.pinGroupId === input.activeGroupId;
}

export type WorkspacePinMutationPlan =
  | { kind: "unsupported" }
  | { kind: "set"; pinned: boolean; groupId: string };

export function planWorkspacePinMutation(input: {
  pinnedAt: string | null | undefined;
  pinGroupId: string | null | undefined;
  activeGroupId: string;
  supportsPinGroups: boolean;
}): WorkspacePinMutationPlan {
  if (!input.supportsPinGroups) return { kind: "unsupported" };
  return {
    kind: "set",
    pinned: !isWorkspacePinnedInGroup(input),
    groupId: input.activeGroupId,
  };
}
