import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
}

export interface PinnedSidebarGroups {
  // Individually pinned chats, hoisted into the Pinned section and removed from their
  // project below. Most recently pinned first.
  pinnedChats: SidebarWorkspacePlacement[];
  // Everything else, with pinned chats removed. Feeds the draggable project list.
  unpinnedProjects: SidebarProjectEntry[];
}

function projectWithoutPinnedWorkspaces(
  project: SidebarProjectEntry,
  pinnedWorkspaceKeys: ReadonlySet<string>,
): SidebarProjectEntry {
  const workspaces = project.workspaces.filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // Keep the project even when every chat moved to Pinned. The project row owns
  // its settings and new-workspace actions; chats are not its ownership boundary.
  return workspaces.length === project.workspaces.length ? project : { ...project, workspaces };
}

interface WorkspacePinFields {
  pinnedAt?: string | null;
  pinGroupId?: string | null;
}

export function buildPinnedSidebarKeys(input: {
  projects: SidebarProjectEntry[];
  workspaceMaps: ReadonlyMap<string, ReadonlyMap<string, WorkspacePinFields>>;
  supportsPinGroupsByServerId: ReadonlyMap<string, boolean>;
  activePinGroupId: string;
}): PinnedSidebarKeys {
  const pinnedWorkspaceKeys: string[] = [];
  const pinnedAtByKey: Record<string, string> = {};

  for (const project of input.projects) {
    for (const placement of project.workspaces) {
      const workspace = input.workspaceMaps.get(placement.serverId)?.get(placement.workspaceId);
      const supportsPinGroups = input.supportsPinGroupsByServerId.get(placement.serverId) === true;
      const isPinned = supportsPinGroups
        ? workspace?.pinGroupId === input.activePinGroupId
        : workspace?.pinnedAt != null;
      if (isPinned) {
        pinnedWorkspaceKeys.push(placement.workspaceKey);
        if (workspace?.pinnedAt) {
          pinnedAtByKey[placement.workspaceKey] = workspace.pinnedAt;
        }
      }
    }
  }
  return { pinnedWorkspaceKeys, pinnedAtByKey };
}

function arePinnedSidebarKeysEqual(left: PinnedSidebarKeys, right: PinnedSidebarKeys): boolean {
  if (left.pinnedWorkspaceKeys.length !== right.pinnedWorkspaceKeys.length) {
    return false;
  }
  for (let index = 0; index < left.pinnedWorkspaceKeys.length; index += 1) {
    const workspaceKey = left.pinnedWorkspaceKeys[index];
    if (
      workspaceKey !== right.pinnedWorkspaceKeys[index] ||
      (workspaceKey && left.pinnedAtByKey[workspaceKey] !== right.pinnedAtByKey[workspaceKey])
    ) {
      return false;
    }
  }
  return true;
}

export function usePinnedSidebarKeys(projects: SidebarProjectEntry[]): PinnedSidebarKeys {
  const previousKeysRef = useRef<PinnedSidebarKeys>({
    pinnedWorkspaceKeys: [],
    pinnedAtByKey: {},
  });
  const serverIds = useMemo(
    () =>
      Array.from(
        new Set(
          projects.flatMap((project) => project.workspaces.map((workspace) => workspace.serverId)),
        ),
      ),
    [projects],
  );
  const supportsPinGroupsByServerId = useHostFeatureMap(serverIds, "workspacePinGroups");
  const activePinGroupId = useSidebarViewStore((state) => state.activePinGroupId);
  const workspaceMaps = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.map((serverId) => state.sessions[serverId]?.workspaces ?? null),
    shallow,
  );
  return useMemo(() => {
    const workspaceMapByServerId = new Map<string, ReadonlyMap<string, WorkspacePinFields>>();
    for (let index = 0; index < serverIds.length; index += 1) {
      const serverId = serverIds[index];
      const workspaceMap = workspaceMaps[index];
      if (serverId && workspaceMap) {
        workspaceMapByServerId.set(serverId, workspaceMap);
      }
    }
    const nextKeys = buildPinnedSidebarKeys({
      projects,
      workspaceMaps: workspaceMapByServerId,
      supportsPinGroupsByServerId,
      activePinGroupId,
    });
    if (arePinnedSidebarKeysEqual(previousKeysRef.current, nextKeys)) {
      return previousKeysRef.current;
    }
    previousKeysRef.current = nextKeys;
    return nextKeys;
  }, [activePinGroupId, projects, serverIds, supportsPinGroupsByServerId, workspaceMaps]);
}

// Splits the sidebar into a dedicated Pinned section (chats) and the regular list below.
// Pinned chats are ordered most-recently-pinned first.
export function splitPinnedSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
}): PinnedSidebarGroups {
  const { projects, keys, pinnedWorkspaceOrder } = input;
  if (keys.pinnedWorkspaceKeys.length === 0) {
    return { pinnedChats: [], unpinnedProjects: projects };
  }
  const pinnedWorkspaceKeySet = new Set(keys.pinnedWorkspaceKeys);
  const pinnedChats: SidebarWorkspacePlacement[] = [];
  const unpinnedProjects: SidebarProjectEntry[] = [];

  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (pinnedWorkspaceKeySet.has(workspace.workspaceKey)) {
        pinnedChats.push(workspace);
      }
    }
    unpinnedProjects.push(projectWithoutPinnedWorkspaces(project, pinnedWorkspaceKeySet));
  }

  pinnedChats.sort((a, b) =>
    (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
      keys.pinnedAtByKey[a.workspaceKey] ?? "",
    ),
  );

  return {
    pinnedChats: applyStoredOrdering({
      items: pinnedChats,
      storedOrder: pinnedWorkspaceOrder,
      getKey: (workspace) => workspace.workspaceKey,
    }),
    unpinnedProjects,
  };
}
