import { join } from "node:path";
import { Updater } from "electrobun/main";
import type { ProjectRuntime, TrustStore } from "../core/index";
import { UpdateCoordinator } from "../updates/coordinator";
import { bundledInstallation, openVerifiedDmg } from "../updates/installation";
import { runMigrationAgent } from "../updates/migration-agent";
import { DIRECT_UNSIGNED_UPDATES_VERIFIED, applyVerifiedNativeUpdate } from "../updates/native-updater";
import { atomicJson, getUpdateSettings, updateDirectory } from "../updates/storage";
import type { UpdateAction, UpdateState } from "../shared/updates";
import type { DashboardAgentHarness } from "./component-agent";
import type { ProjectRegistry } from "./project-registry";

export interface AppUpdatesOptions {
  runtime: ProjectRuntime;
  harness: DashboardAgentHarness;
  registry: ProjectRegistry;
  trustStore: TrustStore;
  /** The bundled agent tool, or this executable in an unbundled run. */
  toolPath: string;
  agentCommand(configPath: string): Promise<string>;
}

const busy = (phase: string): boolean => phase === "running" || phase === "stopping";

/** The update coordinator wired to this app's runtime, agent work, and Electrobun updater. */
export function createAppUpdates(options: AppUpdatesOptions) {
  const { runtime, harness, registry } = options;
  /** True while terminals or agent work run; `configPath` narrows it to one dashboard. */
  const workRunning = (configPath?: string): boolean => {
    const snapshot = runtime.getSnapshot();
    return (configPath === undefined || snapshot.configPath === configPath) && snapshot.processes.some((p) => busy(p.phase))
      || harness.list().some((t) => (configPath === undefined || t.configPath === configPath) && busy(t.process.phase));
  };
  let nativeUpdateApplying = false;
  let operation: Promise<unknown> | null = null;

  const coordinator: UpdateCoordinator = new UpdateCoordinator({
    listDashboards: async () => {
      const active = runtime.getSnapshot().configPath;
      return [...new Set([...(await registry.list()).map((p) => p.configPath), ...active ? [active] : []])];
    },
    install: async (receipt, method) => {
      if (workRunning()) throw new Error("Finish running terminals and agent work before installation. No work has been stopped.");
      await bundledInstallation(options.toolPath);
      if (DIRECT_UNSIGNED_UPDATES_VERIFIED && method !== "dmg") {
        try {
          await applyVerifiedNativeUpdate(Updater, receipt, updateDirectory(), fetch, async () => {
            if (await coordinator.cancelled(receipt)) throw new Error("Update continuation cancelled before restart.");
            if (workRunning()) throw new Error("New work started while staging. Finish it before restarting.");
            nativeUpdateApplying = true;
          });
        } finally { nativeUpdateApplying = false; }
      } else await openVerifiedDmg(receipt);
    },
    migrate: async (configPath, receipt, report, snapshotReady) => {
      if (workRunning(configPath)) throw new Error("Finish running dashboard work before migration.");
      const installation = await bundledInstallation(options.toolPath);
      return runMigrationAgent({ directory: updateDirectory(), configPath, receipt, report, snapshotReady,
        toolPath: installation.cliPath, command: await options.agentCommand(configPath),
        trustStore: options.trustStore, harness, stop: (id) => harness.stop(id),
        cancelled: () => coordinator.cancelled(receipt),
      });
    },
  });
  Updater.onStatusChange((entry) => {
    if (entry.status === "error") {
      coordinator.problem(entry.message);
      void coordinator.recordInstallationProblem(entry.message).catch(() => undefined);
    }
  });

  return {
    /** Native apply has already rejected running work; quit must not veto it. */
    isApplyingNativeUpdate: () => nativeUpdateApplying,

    async state(): Promise<UpdateState> {
      return {
        ...await coordinator.state(),
        directInstallAvailable: DIRECT_UNSIGNED_UPDATES_VERIFIED && (await Updater.localInfo.channel()) === "canary",
      };
    },

    async action(action: UpdateAction): Promise<UpdateState> {
      if (action.type === "prepare" || action.type === "migrate" || action.type === "install") {
        if (action.type === "prepare") await bundledInstallation(options.toolPath);
        if (operation) throw new Error("An update operation is already running.");
        operation = coordinator.action(action).catch((error) => console.error("Update operation needs recovery:", error)).finally(() => { operation = null; });
        return coordinator.state();
      }
      return coordinator.action(action);
    },

    /**
     * Release-only continuation: a development checkout must never consume a
     * user's persisted release authorization or impersonate the installed host.
     */
    async continueRelease(): Promise<void> {
      if ((await Updater.localInfo.channel()) !== "canary") return;
      await atomicJson(join(updateDirectory(), "app-host.json"), { pid: process.pid });
      operation = coordinator.reconcile().catch((error) => coordinator.problem(error)).finally(() => { operation = null; });
      const scheduledCheck = async () => {
        if ((await getUpdateSettings(updateDirectory())).automaticChecks && !operation) await coordinator.check();
      };
      void operation.then(scheduledCheck).catch((error) => console.error("Update check failed:", error));
      setInterval(() => { void scheduledCheck().catch((error) => console.error("Update check failed:", error)); }, 24 * 60 * 60_000);
    },
  };
}

export type AppUpdates = ReturnType<typeof createAppUpdates>;
