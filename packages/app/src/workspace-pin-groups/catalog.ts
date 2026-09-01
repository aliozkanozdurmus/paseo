import type { QueryClient } from "@tanstack/react-query";
import type { WorkspacePinGroup } from "@getpaseo/protocol/messages";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

export function workspacePinGroupsQueryKey(
  serverId: string,
): readonly ["workspacePinGroups", string] {
  return ["workspacePinGroups", serverId];
}

export function applyWorkspacePinGroupCatalog(input: {
  queryClient: QueryClient;
  serverId: string;
  pinGroups: readonly WorkspacePinGroup[];
}): void {
  const pinGroups = [...input.pinGroups];
  input.queryClient.setQueryData(workspacePinGroupsQueryKey(input.serverId), pinGroups);
  useSidebarViewStore.getState().reconcilePinGroups(
    input.serverId,
    pinGroups.map((group) => group.id),
  );
}
