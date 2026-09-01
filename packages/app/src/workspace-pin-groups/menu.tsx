import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react-native";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { WorkspacePinGroup } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MenuHint,
  MenuItem,
  MenuTextField,
  useMenuContext,
  type MenuPageDefinition,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { DEFAULT_WORKSPACE_PIN_GROUP_ID, useSidebarViewStore } from "@/stores/sidebar-view-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useFetchQuery } from "@/data/query";
import { buildWorkspacePinGroupMenuModel } from "./menu-model";

const SWITCH_PAGE_ID = "workspacePinGroupsSwitch";
const CREATE_PAGE_ID = "workspacePinGroupsCreate";
const RENAME_PAGE_ID = "workspacePinGroupsRename";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_PIN_GROUPS: readonly WorkspacePinGroup[] = [];

function pinGroupsQueryKey(serverId: string): readonly ["workspacePinGroups", string] {
  return ["workspacePinGroups", serverId];
}

function getPinGroupClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is disconnected");
  return client;
}

function pinGroupErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function WorkspacePinGroupMenu({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const activeGroupId = useSidebarViewStore((state) => state.activePinGroupId);
  const setActiveGroupId = useSidebarViewStore((state) => state.setActivePinGroupId);
  const [deletePending, setDeletePending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const groupsQuery = useFetchQuery<WorkspacePinGroup[]>({
    queryKey: pinGroupsQueryKey(serverId),
    queryFn: () => getPinGroupClient(serverId).listWorkspacePinGroups(),
    dataShape: "list",
    staleTimeMs: 30_000,
  });
  const refetchGroups = groupsQuery.refetch;
  const groups = groupsQuery.data ?? EMPTY_PIN_GROUPS;
  const model = useMemo(
    () => buildWorkspacePinGroupMenuModel({ groups, activeGroupId }),
    [activeGroupId, groups],
  );

  useEffect(() => {
    if (!groupsQuery.data || model.activeGroup) return;
    setActiveGroupId(DEFAULT_WORKSPACE_PIN_GROUP_ID);
  }, [groupsQuery.data, model.activeGroup, setActiveGroupId]);

  const createGroup = useCallback(
    async (name: string) => {
      const group = await getPinGroupClient(serverId).createWorkspacePinGroup(name);
      await refetchGroups();
      setActiveGroupId(group.id);
    },
    [refetchGroups, serverId, setActiveGroupId],
  );
  const renameGroup = useCallback(
    async (name: string) => {
      if (!model.activeGroup) return;
      await getPinGroupClient(serverId).renameWorkspacePinGroup(model.activeGroup.id, name);
      await refetchGroups();
    },
    [model.activeGroup, refetchGroups, serverId],
  );
  const deleteGroup = useCallback(async () => {
    const activeGroup = model.activeGroup;
    if (!activeGroup || activeGroup.id === DEFAULT_WORKSPACE_PIN_GROUP_ID || deletePending) return;
    const confirmed = await confirmDialog({
      title: t("sidebar.pinned.groups.deleteTitle", { name: activeGroup.name }),
      message: t("sidebar.pinned.groups.deleteDescription"),
      confirmLabel: t("sidebar.pinned.groups.delete"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setDeletePending(true);
    setActionError(null);
    try {
      await getPinGroupClient(serverId).deleteWorkspacePinGroup(activeGroup.id);
      setActiveGroupId(DEFAULT_WORKSPACE_PIN_GROUP_ID);
      await refetchGroups();
    } catch (cause) {
      setActionError(pinGroupErrorMessage(cause, t("sidebar.pinned.groups.actionError")));
    } finally {
      setDeletePending(false);
    }
  }, [deletePending, model.activeGroup, refetchGroups, serverId, setActiveGroupId, t]);

  const switchPage = useMemo(
    () => (
      <>
        {model.choices.map((choice) => (
          <WorkspacePinGroupChoiceRow
            key={choice.group.id}
            choice={choice}
            onSelect={setActiveGroupId}
          />
        ))}
      </>
    ),
    [model.choices, setActiveGroupId],
  );
  const pages = useMemo<readonly MenuPageDefinition[]>(
    () => [
      {
        id: SWITCH_PAGE_ID,
        title: t("sidebar.pinned.groups.switch"),
        content: switchPage,
      },
      {
        id: CREATE_PAGE_ID,
        title: t("sidebar.pinned.groups.create"),
        hoverIntent: false,
        content: (
          <WorkspacePinGroupFormPage
            key="create"
            mode="create"
            initialName=""
            onSubmit={createGroup}
          />
        ),
      },
      ...(model.activeGroup && model.activeGroup.id !== DEFAULT_WORKSPACE_PIN_GROUP_ID
        ? [
            {
              id: RENAME_PAGE_ID,
              title: t("sidebar.pinned.groups.rename"),
              hoverIntent: false,
              content: (
                <WorkspacePinGroupFormPage
                  key={model.activeGroup.id}
                  mode="rename"
                  initialName={model.activeGroup.name}
                  onSubmit={renameGroup}
                />
              ),
            },
          ]
        : []),
    ],
    [createGroup, model.activeGroup, renameGroup, switchPage, t],
  );
  const activeName = model.activeGroup?.name ?? t("sidebar.pinned.title");
  const retryGroups = useCallback(() => {
    void refetchGroups();
  }, [refetchGroups]);
  const selectDelete = useCallback(() => {
    void deleteGroup();
  }, [deleteGroup]);

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityLabel={`${t("sidebar.pinned.groups.menuTitle")}: ${activeName}`}
        style={pinGroupTriggerStyle}
        testID="sidebar-pin-groups-menu-trigger"
      >
        <Text style={styles.triggerLabel} numberOfLines={1}>
          {activeName}
        </Text>
        <ThemedChevronDown size={12} uniProps={mutedMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        width={220}
        pages={pages}
        sheetTitle={t("sidebar.pinned.groups.menuTitle")}
        testID="sidebar-pin-groups-menu"
      >
        {groupsQuery.isPending ? (
          <DropdownMenuHint>{t("sidebar.pinned.groups.loading")}</DropdownMenuHint>
        ) : null}
        {groupsQuery.isError ? (
          <>
            <DropdownMenuHint testID="sidebar-pin-groups-load-error">
              {t("sidebar.pinned.groups.loadError")}
            </DropdownMenuHint>
            <DropdownMenuItem closeOnSelect={false} onSelect={retryGroups}>
              {t("sidebar.pinned.groups.retry")}
            </DropdownMenuItem>
          </>
        ) : null}
        {groupsQuery.isSuccess ? (
          <>
            <DropdownMenuSubTrigger
              id={SWITCH_PAGE_ID}
              value={activeName}
              testID="sidebar-pin-groups-switch"
            >
              {t("sidebar.pinned.groups.switch")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSeparator />
            <DropdownMenuSubTrigger id={CREATE_PAGE_ID} testID="sidebar-pin-group-create">
              {t("sidebar.pinned.groups.create")}
            </DropdownMenuSubTrigger>
            {model.actions.includes("rename") ? (
              <DropdownMenuSubTrigger id={RENAME_PAGE_ID} testID="sidebar-pin-group-rename">
                {t("sidebar.pinned.groups.rename")}
              </DropdownMenuSubTrigger>
            ) : null}
            {model.actions.includes("delete") ? (
              <DropdownMenuItem
                destructive
                status={deletePending ? "pending" : "idle"}
                pendingLabel={t("sidebar.pinned.groups.deleting")}
                closeOnSelect={false}
                onSelect={selectDelete}
                testID="sidebar-pin-group-delete"
              >
                {t("sidebar.pinned.groups.delete")}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {actionError ? (
          <DropdownMenuHint testID="sidebar-pin-groups-action-error">
            {actionError}
          </DropdownMenuHint>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspacePinGroupChoiceRow({
  choice,
  onSelect,
}: {
  choice: { group: WorkspacePinGroup; selected: boolean };
  onSelect: (groupId: string) => void;
}): ReactElement {
  const select = useCallback(() => onSelect(choice.group.id), [choice.group.id, onSelect]);
  return (
    <MenuItem
      selected={choice.selected}
      showSelectedCheck
      onSelect={select}
      testID={`sidebar-pin-group-choice-${choice.group.id}`}
    >
      {choice.group.name}
    </MenuItem>
  );
}

function WorkspacePinGroupFormPage({
  mode,
  initialName,
  onSubmit,
}: {
  mode: "create" | "rename";
  initialName: string;
  onSubmit: (name: string) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("WorkspacePinGroupFormPage");
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const isCreate = mode === "create";
  const submit = useCallback(() => {
    if (!trimmedName || pending) return;
    setPending(true);
    setError(null);
    onSubmit(trimmedName)
      .then(() => menu.goBack())
      .catch((cause: unknown) =>
        setError(pinGroupErrorMessage(cause, t("sidebar.pinned.groups.actionError"))),
      )
      .finally(() => setPending(false));
  }, [menu, onSubmit, pending, t, trimmedName]);

  return (
    <>
      <MenuTextField
        initialValue={initialName}
        onChangeText={setName}
        placeholder={
          isCreate ? t("sidebar.pinned.groups.createName") : t("sidebar.pinned.groups.renameName")
        }
        autoFocus
        editable={!pending}
        onSubmitEditing={submit}
        testID={isCreate ? "sidebar-pin-group-create-input" : "sidebar-pin-group-rename-input"}
      />
      <MenuItem
        disabled={!trimmedName}
        status={pending ? "pending" : "idle"}
        pendingLabel={
          isCreate ? t("sidebar.pinned.groups.creating") : t("sidebar.pinned.groups.renaming")
        }
        closeOnSelect={false}
        onSelect={submit}
        testID={isCreate ? "sidebar-pin-group-create-submit" : "sidebar-pin-group-rename-submit"}
      >
        {isCreate ? t("sidebar.pinned.groups.create") : t("sidebar.pinned.groups.rename")}
      </MenuItem>
      {error ? <MenuHint testID="sidebar-pin-group-form-error">{error}</MenuHint> : null}
    </>
  );
}

function pinGroupTriggerStyle({ hovered, pressed, open }: MenuTriggerState) {
  return [styles.trigger, (hovered || pressed || open) && styles.triggerActive];
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    minWidth: 0,
    maxWidth: 144,
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  triggerActive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  triggerLabel: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
