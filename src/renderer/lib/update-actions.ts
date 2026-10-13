import type { AppUpdatesController } from "../app/use-app-updates";
import { compareVersions, type UpdateAction } from "../../shared/updates";
import type { PaletteAction } from "./actions";

/** Update operations share the panel's controller; migration selection stays in Settings. */
export function buildUpdateActions(updates: AppUpdatesController, draftsOpen: boolean, showUpdates: () => void): PaletteAction[] {
  const { state, pending } = updates;
  const receipt = state?.receipt && !state.receipt.cancelled ? state.receipt : null;
  const busy = pending || Boolean(state && ["checking", "downloading", "migrating", "verifying", "updating-guidance"].includes(state.phase));
  const ready = receipt?.installation === "ready" || receipt?.installation === "awaiting-install";
  const operation = (id: string, label: string, action: UpdateAction, reason?: string, confirmation?: PaletteAction["confirmation"]): PaletteAction => ({
    id, label, group: "Updates", keywords: ["app", "update", "upgrade", "release", "canary"],
    enabled: reason === undefined, disabledReason: reason, confirmation,
    run: async () => { showUpdates(); await updates.act(action); },
  });
  const unavailable = pending ? "An update request is in progress." : !state ? "Loading update status…" : busy ? "An update operation is in progress." : undefined;
  const actions: PaletteAction[] = [{
    id: "app:show-updates", label: "Open updates", description: "Review app updates and select dashboards to migrate.",
    group: "Updates", keywords: ["update", "upgrade", "release", "settings", "migration"], enabled: true, run: showUpdates,
  }, operation("update:check", "Check for updates", { type: "check" }, unavailable)];
  if (state?.release && compareVersions(state.release.metadata.version, state.currentVersion) > 0 && !ready) {
    actions.push(operation("update:download", `Download update to ${state.release.metadata.version}`, { type: "prepare", choice: "update-only", selected: [] },
      unavailable ?? (receipt && receipt.installation !== "failed" ? "Cancel the pending update before downloading again." : undefined)));
  }
  if (ready) {
    const reason = unavailable ?? (draftsOpen ? "Save or cancel the open dashboard draft before installing." : undefined);
    if (state?.directInstallAvailable) actions.push(operation("update:install", "Restart and install update", { type: "install" }, reason, {
      title: "Restart and install update?", message: "dash-bored will restart. Save drafts and finish running terminals and agent work first.", confirmLabel: "Restart and install",
    }));
    actions.push(operation("update:open-installer", "Open update installer", { type: "install", method: "dmg" }, reason));
  }
  const continuing = receipt?.choice === "update-and-migrate" && Object.values(receipt.migrations).some(m => m.status === "pending" || m.status === "running");
  if (receipt && (receipt.installation !== "installed" || continuing)) actions.push(operation("update:cancel", "Cancel update", { type: "cancel" }, pending ? unavailable : undefined));
  if (state?.phase === "problem" && state.message.includes("lock")) actions.push(operation("update:recover", "Recover interrupted update", { type: "recover" }, unavailable));
  return actions;
}
