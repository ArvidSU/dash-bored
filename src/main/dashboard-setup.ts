import { basename } from "node:path";
import { hasErrors, loadProjectDefinition } from "../core/index";
import type { ProjectLocation } from "../core/paths";
import type { ComponentAgentLaunch, DashboardAgentTask, Diagnostic, Permission, ResolvedComponentNode } from "../shared/contracts";
import { buildDiagnosticsAgentPrompt, componentPath, findResolvedNode } from "../shared/component-agent";
import { starterAgentPrompt } from "../core/project-files";

export interface DashboardSetupRuntime {
  getSnapshot(): { projectRoot: string | null; configPath?: string | null; trusted: boolean; tree: ResolvedComponentNode | null; requestedPermissions?: Permission[]; diagnostics?: Diagnostic[] };
  getLaunchEnvironment(configPath: string): Promise<Record<string, string>>;
  getSessionToken?(): number;
  reload(): Promise<unknown>;
}

export interface DashboardSetupHarness {
  launch(options: { command: string; prompt: string; projectRoot: string; componentPath: string; configPath: string; request: string; purpose?: DashboardAgentTask["purpose"]; env?: Record<string, string>; onFinished?: (task: DashboardAgentTask) => void | Promise<void> }): Promise<ComponentAgentLaunch>;
  setValidation(id: string, validation: DashboardAgentTask["validation"]): void;
  isCancelled?(id: string): boolean;
}

export interface DashboardSetupSupervisorOptions {
  runtime: DashboardSetupRuntime;
  harness: DashboardSetupHarness;
  command: string;
  location: ProjectLocation;
  /** Read-only executable preflight, supplied by the desktop host. */
  preflight?: (command: string, env: Record<string, string>, cwd: string) => void;
}

// Only errors an agent can repair inside the owning bundle trigger a retry.
// Missing tools, failed reads, external checkouts and trust failures stay visible.
const REPAIRABLE = /^(?:YAML_INVALID|YAML_TOO_LARGE|(?:CONFIG|LOCK|MANIFEST)_SCHEMA_INVALID|LOCK_COMPONENT_PATH_INVALID|MANIFEST_(?:PROPS_SCHEMA_INVALID|CHILD_.*|RESOURCE_PERMISSION_MISSING|REFERENCE_PERMISSION_MISSING)|NODE_ID_.*|TREE_(?:TOO_LARGE|TOO_DEEP|CYCLE)|COMPONENT_(?:PROPS_INVALID|PROCESS_.*_INVALID|CHILD.*|ID_DUPLICATE|ID_RESERVED|ENTRY_UNSUPPORTED|RESOURCE_REFERENCE_UNKNOWN|COMPILE_FAILED|COMPILE_EMPTY|BUILTIN_UNKNOWN)|CONFIG_LINK_CHILDREN_UNSUPPORTED)$/;

export class DashboardSetupSupervisor {
  private repairAttempted = false;
  private readonly handled = new Set<string>();
  private readonly activeConfig: string | null | undefined;
  private readonly activeRoot: string | null;
  private readonly session: number | undefined;
  private readonly approvedPermissions: Set<Permission>;

  constructor(private readonly options: DashboardSetupSupervisorOptions) {
    const snapshot = options.runtime.getSnapshot();
    this.activeConfig = snapshot.configPath;
    this.activeRoot = snapshot.projectRoot;
    this.session = options.runtime.getSessionToken?.();
    this.approvedPermissions = new Set(snapshot.requestedPermissions ?? []);
  }

  private stillHere(): boolean {
    const current = this.options.runtime.getSnapshot();
    return current.configPath === this.activeConfig && current.projectRoot === this.activeRoot
      && this.options.runtime.getSessionToken?.() === this.session;
  }

  async launch(node: ResolvedComponentNode): Promise<ComponentAgentLaunch> {
    const { runtime, harness, command, location, preflight } = this.options;
    if (this.approvedPermissions.size === 0) {
      for (const permission of node.manifest?.permissions ?? []) this.approvedPermissions.add(permission);
    }
    const configPath = node.sourceConfigPath ?? location.configPath;
    const prompt = starterAgentPrompt(basename(location.projectRoot) || "Project", configPath);
    const env = await runtime.getLaunchEnvironment(configPath);
    preflight?.(command, env, location.projectRoot);
    if (!this.stillHere() || !runtime.getSnapshot().trusted) throw new Error("The active dashboard or its trust changed before setup started.");
    return harness.launch({ command, prompt, purpose: "setup", projectRoot: location.projectRoot,
      componentPath: componentPath(node), configPath, request: "Set up this dashboard", env,
      onFinished: (task) => this.finish(task, prompt, configPath, false),
    });
  }

  private async finish(task: DashboardAgentTask, prompt: string, configPath: string, repair: boolean, originalTaskId?: string): Promise<void> {
    if (this.handled.has(task.id)) return;
    this.handled.add(task.id);
    const { runtime, harness, command, location, preflight } = this.options;
    const cancelled = () => task.cancelled === true || harness.isCancelled?.(task.id) === true
      || (originalTaskId !== undefined && harness.isCancelled?.(originalTaskId) === true);
    const report = (status: NonNullable<DashboardAgentTask["validation"]>["status"], diagnostics: Diagnostic[], message?: string) => {
      const validation = { status, diagnostics, ...(message ? { message } : {}) };
      harness.setValidation(task.id, validation);
      if (originalTaskId) harness.setValidation(originalTaskId, validation);
    };
    report("checking", [], "Checking saved configuration and local components…");
    try {
      const fresh = await loadProjectDefinition(location, { compile: true });
      const diagnostics = structuredClone(fresh.diagnostics);
      if (cancelled() || !this.stillHere()) {
        report("cancelled", diagnostics, "Setup follow-up cancelled; no automatic repair will run.");
        return;
      }
      const additionalPermissions = fresh.permissions.filter((permission) => !this.approvedPermissions.has(permission));
      if (additionalPermissions.length > 0) {
        // Publish the trust delta, but never grant it or launch another process.
        if (!hasErrors(diagnostics)) await runtime.reload();
        report("trust-required", diagnostics, `Review project trust for: ${additionalPermissions.join(", ")}.`);
        return;
      }
      if (!runtime.getSnapshot().trusted) {
        report("trust-required", diagnostics, "Project trust changed; no automatic repair will run.");
        return;
      }
      const cleanExit = task.process.phase === "exited" && task.process.exitCode === 0 && task.process.signal === null;
      if (!cleanExit) {
        report(cancelled() || task.process.signal ? "cancelled" : "failed", diagnostics,
          `Agent ${task.process.signal ? `stopped after ${task.process.signal}` : `exited with code ${String(task.process.exitCode)}`}. ${hasErrors(diagnostics) ? "Configuration errors remain." : "Saved configuration validates."} No automatic repair was started.`);
        return;
      }
      if (!hasErrors(diagnostics)) {
        await runtime.reload();
        if (cancelled() || !this.stillHere()) report("cancelled", diagnostics, "Dashboard changed before validation could be applied.");
        else if (!runtime.getSnapshot().trusted) report("trust-required", diagnostics, "Configuration validates; review project trust to load its privileged components.");
        else if (hasErrors(runtime.getSnapshot().diagnostics ?? [])) report("failed", runtime.getSnapshot().diagnostics ?? [], "The dashboard changed during validation and could not be loaded.");
        else report("valid", diagnostics, "Saved dashboard configuration and local components validate.");
        return;
      }
      if (repair || this.repairAttempted || diagnostics.some((item) => item.severity === "error" && !REPAIRABLE.test(item.code))) {
        report("failed", diagnostics, repair ? "Configuration errors remain after the single repair attempt." : "Review these diagnostics before running setup again.");
        return;
      }
      this.repairAttempted = true;
      const repairPrompt = buildDiagnosticsAgentPrompt({ projectRoot: location.projectRoot, configPath, diagnostics, originalPrompt: prompt });
      const env = await runtime.getLaunchEnvironment(configPath);
      preflight?.(command, env, location.projectRoot);
      if (cancelled() || !this.stillHere() || !runtime.getSnapshot().trusted) {
        report("cancelled", diagnostics, "Setup follow-up cancelled before repair launch.");
        return;
      }
      report("repairing", diagnostics, "Starting the single automatic repair attempt.");
      await harness.launch({ command, prompt: repairPrompt, purpose: "setup-repair", projectRoot: location.projectRoot,
        componentPath: `${configPath}#diagnostics`, configPath, request: "Repair setup diagnostics.", env,
        onFinished: async (repairTask) => {
          await this.finish(repairTask, prompt, configPath, true, task.id);
        },
      });
    } catch (error) {
      report("failed", [{ severity: "error", code: "DASHBOARD_SETUP_FOLLOWUP_FAILED", message: error instanceof Error ? error.message : String(error) }], "Setup validation or repair could not finish. Review the error and retry when ready.");
    }
  }
}

export function findSetupNode(runtime: DashboardSetupRuntime, nodeId: string): ResolvedComponentNode | null {
  const snapshot = runtime.getSnapshot();
  const node = snapshot.tree ? findResolvedNode(snapshot.tree, nodeId) : null;
  return node?.manifest?.permissions?.includes("process:execute") ? node : null;
}
