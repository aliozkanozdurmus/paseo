import { describe, expect, it } from "vitest";
import {
  buildWorkspacePinGroupMenuModel,
  isWorkspacePinnedInGroup,
  planWorkspacePinMutation,
} from "./menu-model";

const groups = [
  { id: "default", name: "Pinned", createdAt: "2026-01-01T00:00:00Z" },
  { id: "team", name: "Team", createdAt: "2026-02-01T00:00:00Z" },
];

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
  it("treats a workspace in another group as unpinned on a supported host", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinnedAt: null,
        pinGroupId: "review",
        activeGroupId: "team",
        supportsPinGroups: true,
      }),
    ).toBe(false);
  });

  it("preserves legacy pinned state on an older host", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinnedAt: "2026-02-01T00:00:00Z",
        pinGroupId: undefined,
        activeGroupId: "team",
        supportsPinGroups: false,
      }),
    ).toBe(true);
  });

  it("recognizes active non-default membership without a legacy timestamp", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinnedAt: null,
        pinGroupId: "team",
        activeGroupId: "team",
        supportsPinGroups: true,
      }),
    ).toBe(true);
  });
});

describe("planWorkspacePinMutation", () => {
  it("moves a workspace from another group into the active group", () => {
    expect(
      planWorkspacePinMutation({
        pinnedAt: null,
        pinGroupId: "review",
        activeGroupId: "team",
        supportsPinGroups: true,
      }),
    ).toEqual({ kind: "set", pinned: true, groupId: "team" });
  });

  it("unpins a workspace from the active group with the group id", () => {
    expect(
      planWorkspacePinMutation({
        pinnedAt: null,
        pinGroupId: "team",
        activeGroupId: "team",
        supportsPinGroups: true,
      }),
    ).toEqual({ kind: "set", pinned: false, groupId: "team" });
  });

  it("does not plan a legacy mutation for an old host", () => {
    expect(
      planWorkspacePinMutation({
        pinnedAt: "2026-01-01T00:00:00Z",
        pinGroupId: null,
        activeGroupId: "default",
        supportsPinGroups: false,
      }),
    ).toEqual({ kind: "unsupported" });
  });
});
