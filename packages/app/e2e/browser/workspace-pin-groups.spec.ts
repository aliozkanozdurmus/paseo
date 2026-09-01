import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { pinWorkspaceFromSidebar } from "../support/helpers/sidebar";

const DEFAULT_GROUP_NAME = "Pinned";
const SECOND_GROUP_NAME = "Deep work";
const RENAMED_GROUP_NAME = "Focus";
const ALPHA_WORKSPACE_NAME = "Alpha pinned workspace";
const BETA_WORKSPACE_NAME = "Beta pinned workspace";
const GROUP_NOT_FOUND_ERROR = "Pin group not found";

function workspaceRowTestId(workspaceId: string, serverId = getServerId()): string {
  return `sidebar-workspace-row-${serverId}:${workspaceId}`;
}

function workspaceRow(page: Page, workspaceId: string, serverId = getServerId()) {
  return page.getByTestId(workspaceRowTestId(workspaceId, serverId));
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

function pinGroupChoice(page: Page, name: string) {
  return page.locator('[data-testid^="sidebar-pin-group-choice-"]').filter({ hasText: name });
}

async function switchPinGroup(page: Page, name: string): Promise<string> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-groups-switch").click();

  const choice = pinGroupChoice(page, name);
  await expect(choice).toHaveCount(1, { timeout: 10_000 });

  const testId = await choice.getAttribute("data-testid");
  if (!testId) throw new Error(`Pin group choice for ${name} has no data-testid`);
  await choice.click();
  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name);
  await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
  return testId.replace("sidebar-pin-group-choice-", "");
}

async function openPinGroupSwitcher(page: Page): Promise<void> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-groups-switch").click();
  await expect(pinGroupChoice(page, DEFAULT_GROUP_NAME)).toBeVisible({ timeout: 10_000 });
}

async function renameActivePinGroupWithRetry(page: Page, name: string): Promise<void> {
  await openPinGroupsMenu(page);
  await page.getByTestId("sidebar-pin-group-rename").click();

  const input = page.getByTestId("sidebar-pin-group-rename-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByTestId("sidebar-pin-group-rename-submit").click();

  await expect(page.getByTestId("sidebar-pin-group-form-error")).toContainText(
    GROUP_NOT_FOUND_ERROR,
    { timeout: 10_000 },
  );
  await expect(input).toBeVisible();
  await expect(input).toBeEditable();

  await page.getByTestId("sidebar-pin-group-rename-submit").click();
  await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(name, {
    timeout: 10_000,
  });
  await expect(input).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
}

async function deleteActivePinGroup(page: Page, name: string): Promise<void> {
  await openPinGroupsMenu(page);
  const confirmationMessage = new Promise<string>((resolve) =>
    page.once("dialog", (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    }),
  );

  await page.getByTestId("sidebar-pin-group-delete").click();
  await expect(confirmationMessage).resolves.toContain(name);
}

async function hideExpoFastRefreshOverlay(page: Page): Promise<void> {
  // Expo injects this fixed black lightning badge while Metro applies a fast refresh. Its timing
  // is unrelated to the product UI, so keep it out of deterministic QA captures.
  await page.addStyleTag({
    content: ".__expo_fast_refresh { display: none !important; }",
  });
}

interface PinGroupMutationGate {
  renameAttemptCount(): number;
}

function readSessionMessage(
  message: string | Buffer,
): { type?: unknown; requestId?: unknown } | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    if (envelope.type !== "session" || typeof envelope.message !== "object") return null;
    return envelope.message as { type?: unknown; requestId?: unknown };
  } catch {
    return null;
  }
}

async function installPinGroupMutationGate(page: Page): Promise<PinGroupMutationGate> {
  let renameAttempts = 0;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = readSessionMessage(message);
      if (
        request?.type === "workspace.pin_group.rename.request" &&
        typeof request.requestId === "string"
      ) {
        renameAttempts += 1;
        if (renameAttempts === 1) {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId: request.requestId,
                  requestType: "workspace.pin_group.rename.request",
                  error: GROUP_NOT_FOUND_ERROR,
                  code: "group_not_found",
                },
              },
            }),
          );
          return;
        }
      }

      try {
        server.send(message);
      } catch {
        // server socket already closed
      }
    });

    server.onMessage((message) => {
      try {
        ws.send(message);
      } catch {
        // client socket already closed
      }
    });
  });

  return { renameAttemptCount: () => renameAttempts };
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

async function fetchWorkspaceDescriptor(workspace: SeededWorkspace) {
  const descriptor = (await workspace.client.fetchWorkspaces()).entries.find(
    (entry) => entry.id === workspace.workspaceId,
  );
  if (!descriptor) throw new Error(`Workspace ${workspace.workspaceId} is missing from daemon`);
  return descriptor;
}

async function fetchPinGroupId(workspace: SeededWorkspace): Promise<string | null> {
  const descriptor = await fetchWorkspaceDescriptor(workspace);
  return descriptor.pinGroupId ?? null;
}

test.describe("Workspace pin groups", () => {
  test.describe.configure({ timeout: 240_000 });

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
      const mutationGate = await installPinGroupMutationGate(page);
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

      await test.step("keeps a failed rename visible and allows a successful retry", async () => {
        await renameActivePinGroupWithRetry(page, RENAMED_GROUP_NAME);
        expect(mutationGate.renameAttemptCount()).toBe(2);
      });

      const defaultGroupId = await switchPinGroup(page, DEFAULT_GROUP_NAME);
      expect(defaultGroupId).toBe("default");
      await expectOnlyWorkspacePinned(page, alpha, beta);
      await hideExpoFastRefreshOverlay(page);
      await page.screenshot({
        path: testInfo.outputPath("default-pin-group.png"),
        fullPage: true,
      });

      const secondGroupId = await switchPinGroup(page, RENAMED_GROUP_NAME);
      await expectOnlyWorkspacePinned(page, beta, alpha);

      await page.reload();

      await expectOnlyWorkspacePinned(page, beta, alpha);
      await expect(fetchPinGroupId(alpha)).resolves.toBe(defaultGroupId);
      await expect(fetchPinGroupId(beta)).resolves.toBe(secondGroupId);
      await hideExpoFastRefreshOverlay(page);
      await page.screenshot({
        path: testInfo.outputPath("active-pin-group-after-reload.png"),
        fullPage: true,
      });

      await test.step("captures the open switcher with both group choices", async () => {
        await openPinGroupSwitcher(page);
        await expect(pinGroupChoice(page, DEFAULT_GROUP_NAME)).toHaveCount(1);
        await expect(pinGroupChoice(page, RENAMED_GROUP_NAME)).toHaveCount(1);
        await hideExpoFastRefreshOverlay(page);
        await page.screenshot({
          path: testInfo.outputPath("pin-group-switcher-menu-open.png"),
          fullPage: true,
        });
        await pinGroupChoice(page, RENAMED_GROUP_NAME).click();
        await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
      });

      await test.step("deletes the group without archiving its workspace", async () => {
        await deleteActivePinGroup(page, RENAMED_GROUP_NAME);
        await expect(page.getByTestId("sidebar-pin-groups-menu-trigger")).toContainText(
          DEFAULT_GROUP_NAME,
          { timeout: 10_000 },
        );
        await expectOnlyWorkspacePinned(page, alpha, beta);
        await expect(workspaceRow(page, beta.workspaceId)).toBeVisible({ timeout: 10_000 });
        const unpinnedWorkspace = await fetchWorkspaceDescriptor(beta);
        expect(unpinnedWorkspace.pinGroupId ?? null).toBeNull();
        expect(unpinnedWorkspace.archivedAt ?? null).toBeNull();
      });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("keeps custom groups isolated to their daemon", async ({ page }) => {
    const primary = await seedWorkspace({
      repoPrefix: "pin-groups-primary-host-",
      title: "Primary host workspace",
    });
    const secondaryDaemon = await startIsolatedHostDaemon("srv_pin_groups_secondary");
    let secondary: SeededWorkspace | null = null;

    try {
      secondary = await seedWorkspace({
        repoPrefix: "pin-groups-secondary-host-",
        title: "Secondary host workspace",
        port: secondaryDaemon.port,
      });

      await gotoAppShell(page);
      await expect(workspaceRow(page, primary.workspaceId)).toBeVisible({ timeout: 30_000 });
      await createPinGroup(page, "Primary only");
      await switchPinGroup(page, DEFAULT_GROUP_NAME);

      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Pin groups secondary",
        port: secondaryDaemon.port,
      });
      await waitForConnectedHost(page, {
        serverId: secondaryDaemon.serverId,
        endpoint: `localhost:${secondaryDaemon.port}`,
      });

      const secondaryRow = workspaceRow(page, secondary.workspaceId, secondaryDaemon.serverId);
      await expect(secondaryRow).toBeVisible({ timeout: 30_000 });
      await secondaryRow.click();
      await openPinGroupSwitcher(page);
      await expect(pinGroupChoice(page, "Primary only")).toHaveCount(0);
      await pinGroupChoice(page, DEFAULT_GROUP_NAME).click();
      await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);

      await createPinGroup(page, "Secondary only");
      await switchPinGroup(page, DEFAULT_GROUP_NAME);

      const primaryRow = workspaceRow(page, primary.workspaceId);
      await expect(primaryRow).toBeVisible({ timeout: 30_000 });
      await primaryRow.click();
      await openPinGroupSwitcher(page);
      await expect(pinGroupChoice(page, "Primary only")).toHaveCount(1);
      await expect(pinGroupChoice(page, "Secondary only")).toHaveCount(0);
      await pinGroupChoice(page, DEFAULT_GROUP_NAME).click();
      await expect(page.getByTestId("sidebar-pin-groups-menu")).toHaveCount(0);
    } finally {
      await secondary?.cleanup();
      await secondaryDaemon.close();
      await primary.cleanup();
    }
  });
});
