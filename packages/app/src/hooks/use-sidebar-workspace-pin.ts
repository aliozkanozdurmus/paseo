import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { hostSupportsFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { planWorkspacePinMutation } from "@/workspace-pin-groups/menu-model";

// Everything the pin toggle actually needs. Kept narrower than SidebarWorkspaceEntry so the
// global keyboard handler can build one from the active route selection without a sidebar row.
export type PinnableWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "pinnedAt" | "pinGroupId"
>;

export type ToggleSidebarWorkspacePin = (workspace: PinnableWorkspace) => void;

// Module scope, not a per-hook ref: the sidebar row menus and the global keyboard shortcut each
// hold their own controller instance, and a per-instance guard would let a keypress and a menu
// click fire two concurrent, opposite setWorkspacePinned calls for the same workspace.
const pendingWorkspaceKeys = new Set<string>();

export function useSidebarWorkspacePinController(): ToggleSidebarWorkspacePin {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async ({
      workspace,
      pinned,
      groupId,
    }: {
      workspace: PinnableWorkspace;
      pinned: boolean;
      groupId: string;
    }) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspacePinned(workspace.workspaceId, pinned, groupId);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, { workspace }) => {
      pendingWorkspaceKeys.delete(workspace.workspaceKey);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace: PinnableWorkspace) => {
      if (pendingWorkspaceKeys.has(workspace.workspaceKey)) {
        return;
      }
      const serverInfo = useSessionStore.getState().sessions[workspace.serverId]?.serverInfo;
      const supportsPinGroups = hostSupportsFeature(serverInfo, "workspacePinGroups");
      const activeGroupId = useSidebarViewStore.getState().activePinGroupId;
      const plan = planWorkspacePinMutation({
        pinnedAt: workspace.pinnedAt,
        pinGroupId: workspace.pinGroupId,
        activeGroupId,
        supportsPinGroups,
      });
      if (plan.kind === "unsupported") {
        toast.error(t("sidebar.pinned.groups.updateHost"));
        return;
      }
      pendingWorkspaceKeys.add(workspace.workspaceKey);
      mutate({ workspace, pinned: plan.pinned, groupId: plan.groupId });
    },
    [mutate, t, toast],
  );
}
