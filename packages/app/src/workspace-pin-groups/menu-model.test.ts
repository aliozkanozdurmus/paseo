import { describe, expect, it } from "vitest";
import {
  buildWorkspacePinGroupMenuModel,
  canWorkspaceUseActivePinGroup,
  isWorkspacePinnedInGroup,
  planWorkspacePinMutation,
  resolveWorkspacePinGroupServerId,
} from "./menu-model";

const groups = [
  { id: "default", name: "Pinned", createdAt: "2026-01-01T00:00:00Z" },
  { id: "team", name: "Team", createdAt: "2026-02-01T00:00:00Z" },
];

describe("resolveWorkspacePinGroupServerId", () => {
  const supportsPinGroupsByServerId = new Map([
    ["server-b", true],
    ["server-a", true],
    ["legacy", false],
  ]);

  it("prefers the capable host of the active workspace", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        connectedServerIds: ["server-b", "server-a", "legacy"],
        supportsPinGroupsByServerId,
        activeGroupId: "default",
        activeGroupServerId: null,
        activeWorkspaceServerId: "server-b",
        hostFilters: ["server-a"],
      }),
    ).toBe("server-b");
  });

  it("uses a sole capable sidebar host filter without an active workspace host", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        connectedServerIds: ["server-b", "server-a", "legacy"],
        supportsPinGroupsByServerId,
        activeGroupId: "default",
        activeGroupServerId: null,
        activeWorkspaceServerId: "legacy",
        hostFilters: ["server-b"],
      }),
    ).toBe("server-b");
  });

  it("uses the sole connected capable host", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        connectedServerIds: ["legacy", "server-a"],
        supportsPinGroupsByServerId,
        activeGroupId: "default",
        activeGroupServerId: null,
        activeWorkspaceServerId: null,
        hostFilters: [],
      }),
    ).toBe("server-a");
  });

  it("falls back deterministically when multiple capable hosts are connected", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        connectedServerIds: ["server-b", "server-a", "legacy"],
        supportsPinGroupsByServerId,
        activeGroupId: "default",
        activeGroupServerId: null,
        activeWorkspaceServerId: null,
        hostFilters: [],
      }),
    ).toBe("server-a");
  });

  it("keeps a custom group switcher on its owning host", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        connectedServerIds: ["server-b", "server-a"],
        supportsPinGroupsByServerId,
        activeGroupId: "team",
        activeGroupServerId: "server-a",
        activeWorkspaceServerId: "server-b",
        hostFilters: ["server-b"],
      }),
    ).toBe("server-a");
  });

  it("waits for a custom group's owner instead of binding another capable host", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        connectedServerIds: ["server-b", "server-a"],
        supportsPinGroupsByServerId: new Map([
          ["server-b", true],
          ["server-a", false],
        ]),
        activeGroupId: "team",
        activeGroupServerId: "server-a",
        activeWorkspaceServerId: "server-b",
        hostFilters: ["server-b"],
      }),
    ).toBeNull();
  });
});

describe("canWorkspaceUseActivePinGroup", () => {
  it("scopes custom-group pinning to the owning host", () => {
    const input = {
      supportsPinGroups: true,
      supportsLegacyPinning: true,
      activeGroupId: "team",
      activeGroupServerId: "server-a",
    };

    expect(canWorkspaceUseActivePinGroup({ ...input, workspaceServerId: "server-a" })).toBe(true);
    expect(canWorkspaceUseActivePinGroup({ ...input, workspaceServerId: "server-b" })).toBe(false);
  });

  it("allows the reserved default group on capable and legacy hosts", () => {
    expect(
      canWorkspaceUseActivePinGroup({
        workspaceServerId: "server-b",
        supportsPinGroups: true,
        supportsLegacyPinning: true,
        activeGroupId: "default",
        activeGroupServerId: null,
      }),
    ).toBe(true);
    expect(
      canWorkspaceUseActivePinGroup({
        workspaceServerId: "legacy",
        supportsPinGroups: false,
        supportsLegacyPinning: true,
        activeGroupId: "default",
        activeGroupServerId: null,
      }),
    ).toBe(true);
  });
});

describe("buildWorkspacePinGroupMenuModel", () => {
  it("marks the active choice and protects the default group", () => {
    expect(buildWorkspacePinGroupMenuModel({ groups, activeGroupId: "default" })).toEqual({
      activeGroup: groups[0],
      choices: [
        { group: groups[0], selected: true },
        { group: groups[1], selected: false },
      ],
      actions: ["create"],
    });
  });

  it("offers rename and delete for a custom active group", () => {
    expect(buildWorkspacePinGroupMenuModel({ groups, activeGroupId: "team" })).toEqual({
      activeGroup: groups[1],
      choices: [
        { group: groups[0], selected: false },
        { group: groups[1], selected: true },
      ],
      actions: ["create", "rename", "delete"],
    });
  });
});

describe("isWorkspacePinnedInGroup", () => {
  it("treats a workspace in another group as unpinned", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinGroupId: "review",
        activeGroupId: "team",
      }),
    ).toBe(false);
  });

  it("recognizes active non-default membership without a legacy timestamp", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinGroupId: "team",
        activeGroupId: "team",
      }),
    ).toBe(true);
  });
});

describe("planWorkspacePinMutation", () => {
  it("moves a workspace from another group into the active group", () => {
    expect(
      planWorkspacePinMutation({
        pinGroupId: "review",
        activeGroupId: "team",
      }),
    ).toEqual({ groupId: "team" });
  });

  it("unpins a workspace from the active group", () => {
    expect(
      planWorkspacePinMutation({
        pinGroupId: "team",
        activeGroupId: "team",
      }),
    ).toEqual({ groupId: null });
  });
});
