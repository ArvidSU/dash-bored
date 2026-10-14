import { expect, test } from "bun:test";
import type { UpdateAction, UpdateState } from "../../src/shared/updates";
import { agentActionRefusal } from "../../src/shared/agent-control";
import { buildPackageUpdateActions, buildUpdateActions, pendingUpdateCount } from "../../src/renderer/lib/update-actions";
import { INITIAL_PACKAGE_UPDATE_STATE, type PackageUpdateCommand, type PackageUpdateItem, type PackageUpdateState } from "../../src/shared/package-updates";
import { rankActions } from "../../src/renderer/lib/actions";

const state: UpdateState = { currentVersion: "0.4.2", settings: { channel: "canary", automaticChecks: true },
  release: null, receipt: null, dashboards: [], phase: "idle", message: "" };

test("update commands are discoverable without a dashboard and downloads never authorize migrations", async () => {
  const calls: UpdateAction[] = [];
  let shown = 0;
  const updates = { state: { ...state, release: { metadata: { version: "0.5.0" } } } as UpdateState,
    error: "", pending: false, act: async (action: UpdateAction) => { calls.push(action); } };
  const actions = buildUpdateActions(updates, false, () => { shown++; });
  expect(rankActions(actions, "update").map(a => a.id)).toContain("app:show-updates");
  await actions.find(a => a.id === "update:check")!.run();
  await actions.find(a => a.id === "update:download")!.run();
  expect(calls).toEqual([{ type: "check" }, { type: "prepare", choice: "update-only", selected: [] }]);
  expect(shown).toBe(2);
  updates.state.release!.metadata.version = "0.3.0";
  expect(buildUpdateActions(updates, false, () => {}).some(a => a.id === "update:download")).toBe(false);
});

test("ready updates confirm restart, respect drafts, and remain cancellable while working", () => {
  const updates = { state: { ...state, directInstallAvailable: true, phase: "ready", receipt: { installation: "ready", cancelled: false } } as UpdateState,
    error: "", pending: false, act: async () => {} };
  const actions = buildUpdateActions(updates, false, () => {});
  expect(actions.find(a => a.id === "update:install")).toMatchObject({ enabled: true, confirmation: { confirmLabel: "Restart and install" } });
  expect(agentActionRefusal(actions.find(a => a.id === "update:install")!)).toContain("confirmation");
  expect(buildUpdateActions(updates, true, () => {}).find(a => a.id === "update:install")).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("draft") });
  updates.state.phase = "downloading";
  const busy = buildUpdateActions(updates, false, () => {});
  expect(busy.find(a => a.id === "update:install")?.enabled).toBe(false);
  expect(busy.find(a => a.id === "update:check")?.enabled).toBe(false);
  expect(busy.find(a => a.id === "update:cancel")?.enabled).toBe(true);
  updates.state.phase = "problem";
  updates.state.message = "Another update operation owns the lock.";
  expect(buildUpdateActions(updates, false, () => {}).find(a => a.id === "update:recover")?.enabled).toBe(true);
  updates.state.receipt!.installation = "installed";
  updates.state.receipt!.choice = "update-and-migrate";
  updates.state.receipt!.migrations = { '/dashboard': { status: 'running' } };
  expect(buildUpdateActions(updates, false, () => {}).find(a => a.id === "update:cancel")?.enabled).toBe(true);
});

test("package palette actions check, bulk-update only updatable packages, and count pending updates", async () => {
  const commands: PackageUpdateCommand[] = [];
  let shown = 0;
  const item = (id: string, patch: Partial<PackageUpdateItem> = {}): PackageUpdateItem => ({
    id, kind: "component", name: id, url: `https://example.com/${id}.git`, configPath: "/p/.dash-bored/dash-bored.yaml", dashboardName: "P",
    current: { commit: "a".repeat(40) }, latest: { commit: "b".repeat(40) }, status: "available", ...patch,
  });
  const packageState: PackageUpdateState = { ...INITIAL_PACKAGE_UPDATE_STATE, checkedAt: "2026-10-14T00:00:00.000Z",
    packages: [item("core"), item("dirty", { blocked: "Has local changes." }), item("same", { status: "current" })] };
  const packages = { state: packageState, error: "", pending: false, command: async (command: PackageUpdateCommand) => { commands.push(command); } };
  const actions = buildPackageUpdateActions(packages, () => { shown++; });
  expect(rankActions(actions, "theme").map(a => a.id)).toEqual(expect.arrayContaining(["packages:check", "packages:update-all"]));
  expect(actions.find(a => a.id === "packages:update-all")?.label).toBe("Update core package");
  await actions.find(a => a.id === "packages:check")!.run();
  await actions.find(a => a.id === "packages:update-all")!.run();
  expect(commands).toEqual([{ type: "check" }, { type: "update", ids: ["core"] }]);
  expect(shown).toBe(2);
  expect(pendingUpdateCount({ ...state, release: { metadata: { version: "0.5.0" } } } as UpdateState, packageState)).toBe(2);
  expect(pendingUpdateCount(state, null)).toBe(0);
  const busy = buildPackageUpdateActions({ ...packages, state: { ...packageState, phase: "checking" } }, () => {});
  expect(busy.every(a => !a.enabled)).toBe(true);
});
