import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { pinWorkspaceFromSidebar } from "../support/helpers/sidebar";

const DEFAULT_GROUP_NAME = "Pinned";
const SECOND_GROUP_NAME = "Focus";
const ALPHA_WORKSPACE_NAME = "Alpha pinned workspace";
const BETA_WORKSPACE_NAME = "Beta pinned workspace";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(workspaceRowTestId(workspaceId));
}

function pinnedSection(page: Page) {
  return page.getByTestId("sidebar-pinned-section");
}

async function openPinGroupsMenu(page: Page): Promise<void> {
  await page.getByTestId("sidebar-pin-groups-menu-trigger").click();
  await expect(page.getByTestId("sidebar-pin-groups-menu")).toBeVisible({ timeout: 10_000 });
}

async function createPinGroup(page: Page, name: string): Promise<void> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-group-create").click();

  const input = page.getByTestId("sidebar-pin-group-create-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByTestId("sidebar-pin-group-create-submit").click();

  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name, {
    timeout: 10_000,
  });
  await expect(input).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
}

async function switchPinGroup(page: Page, name: string): Promise<string> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-groups-switch").click();

  const choice = page.locator('[data-testid^="sidebar-pin-group-choice-"]').filter({
    hasText: name,
  });
  await expect(choice).toHaveCount(1, { timeout: 10_000 });

  const testId = await choice.getAttribute("data-testid");
  if (!testId) throw new Error(`Pin group choice for ${name} has no data-testid`);
  await choice.click();
  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name);
  await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
  return testId.replace("sidebar-pin-group-choice-", "");
}

async function expectOnlyWorkspacePinned(
  page: Page,
  visible: SeededWorkspace,
  hidden: SeededWorkspace,
): Promise<void> {
  const section = pinnedSection(page);
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId(workspaceRowTestId(visible.workspaceId))).toBeVisible({
    timeout: 10_000,
  });
  await expect(section.getByTestId(workspaceRowTestId(hidden.workspaceId))).toHaveCount(0);
}

async function fetchPinGroupId(workspace: SeededWorkspace): Promise<string | null> {
  const descriptor = (await workspace.client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === workspace.workspaceId,
  );
  if (!descriptor) throw new Error(`Workspace ${workspace.workspaceId} is missing from daemon`);
  return (descriptor as typeof descriptor & { pinGroupId?: string | null }).pinGroupId ?? null;
}

test.describe("Workspace pin groups", () => {
  test.describe.configure({ timeout: 180_000 });

  test("keeps each group's membership and active selection across reload", async ({
    page,
  }, testInfo) => {
    const alpha = await seedWorkspace({
      repoPrefix: "pin-groups-alpha-",
      title: ALPHA_WORKSPACE_NAME,
    });
    const beta = await seedWorkspace({
      repoPrefix: "pin-groups-beta-",
      title: BETA_WORKSPACE_NAME,
    });

    try {
      await gotoAppShell(page);
      await expect(workspaceRow(page, alpha.workspaceId)).toContainText(ALPHA_WORKSPACE_NAME, {
        timeout: 30_000,
      });
      await expect(workspaceRow(page, beta.workspaceId)).toContainText(BETA_WORKSPACE_NAME, {
        timeout: 30_000,
      });

      await test.step("pins one workspace in the default group", async () => {
        await pinWorkspaceFromSidebar(page, alpha.workspaceId);
        await expectOnlyWorkspacePinned(page, alpha, beta);
      });

      await test.step("creates a second group and pins the other workspace there", async () => {
        await createPinGroup(page, SECOND_GROUP_NAME);
        const secondGroupId = await switchPinGroup(page, SECOND_GROUP_NAME);
        expect(secondGroupId).not.toBe("default");

        await pinWorkspaceFromSidebar(page, beta.workspaceId);
        await expectOnlyWorkspacePinned(page, beta, alpha);
      });

      const defaultGroupId = await switchPinGroup(page, DEFAULT_GROUP_NAME);
      expect(defaultGroupId).toBe("default");
      await expectOnlyWorkspacePinned(page, alpha, beta);
      await page.screenshot({
        path: testInfo.outputPath("default-pin-group.png"),
        fullPage: true,
      });

      const secondGroupId = await switchPinGroup(page, SECOND_GROUP_NAME);
      await expectOnlyWorkspacePinned(page, beta, alpha);

      await page.reload();

      await expectOnlyWorkspacePinned(page, beta, alpha);
      await expect(fetchPinGroupId(alpha)).resolves.toBe(defaultGroupId);
      await expect(fetchPinGroupId(beta)).resolves.toBe(secondGroupId);
      await page.screenshot({
        path: testInfo.outputPath("active-pin-group-after-reload.png"),
        fullPage: true,
      });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });
});
