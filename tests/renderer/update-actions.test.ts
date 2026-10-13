import { expect, test } from "bun:test";
import type { UpdateAction, UpdateState } from "../../src/shared/updates";
import { agentActionRefusal } from "../../src/shared/agent-control";
import { buildUpdateActions } from "../../src/renderer/lib/update-actions";
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
