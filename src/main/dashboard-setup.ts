import { basename } from "node:path";
import { hasErrors, loadProjectDefinition } from "../core/index";
import type { ProjectLocation } from "../core/paths";
import type { AgentSessionTask } from "../shared/agent-session";
import type { ComponentAgentLaunch, Diagnostic, Permission, ResolvedComponentNode } from "../shared/contracts";
import { buildDiagnosticsAgentPrompt, componentPath, findResolvedNode } from "../shared/component-agent";
import { starterAgentPrompt } from "../core/project-files";
import type { AgentSessionLaunchOptions } from "./agent-sessions";

export interface DashboardSetupRuntime {
  getSnapshot(): { projectRoot: string | null; configPath?: string | null; trusted: boolean; tree: ResolvedComponentNode | null; requestedPermissions?: Permission[]; diagnostics?: Diagnostic[] };
  getLaunchEnvironment(configPath: string): Promise<Record<string, string>>;
  getSessionToken?(): number;
  reload(): Promise<unknown>;
}

/** The part of `AgentSessions` the supervisor drives. */
export interface DashboardSetupHarness {
  launch(options: AgentSessionLaunchOptions): Promise<ComponentAgentLaunch>;
  /** A follow-up prompt in the task's own session, such as the single automatic repair. */
  followUp(id: string, prompt: string): void | Promise<void>;
  setValidation(id: string, validation: AgentSessionTask["validation"]): void;
  isCancelled?(id: string): boolean;
}

type Validation = NonNullable<AgentSessionTask["validation"]>;

export interface DashboardSetupSupervisorOptions {
  runtime: DashboardSetupRuntime;
  harness: DashboardSetupHarness;
  command: string;
  location: ProjectLocation;
  onValidation?: (validation: Validation) => void;
  /** Read-only executable preflight, supplied by the desktop host. */
  preflight?: (command: string, env: Record<string, string>, cwd: string) => void;
}

// Only errors an agent can repair inside the owning bundle trigger a retry.
// Missing tools, failed reads, external checkouts and trust failures stay visible.
const REPAIRABLE = /^(?:YAML_INVALID|YAML_TOO_LARGE|(?:CONFIG|LOCK|MANIFEST)_SCHEMA_INVALID|LOCK_COMPONENT_PATH_INVALID|MANIFEST_(?:PROPS_SCHEMA_INVALID|CHILD_.*|RESOURCE_PERMISSION_MISSING|REFERENCE_PERMISSION_MISSING)|NODE_ID_.*|TREE_(?:TOO_LARGE|TOO_DEEP|CYCLE)|COMPONENT_(?:PROPS_INVALID|PROCESS_.*_INVALID|CHILD.*|ID_DUPLICATE|ID_RESERVED|ENTRY_UNSUPPORTED|RESOURCE_REFERENCE_UNKNOWN|COMPILE_FAILED|COMPILE_EMPTY|BUILTIN_UNKNOWN)|CONFIG_LINK_CHILDREN_UNSUPPORTED)$/;

function turnOutcome(task: AgentSessionTask): string {
  if (task.state === "failed") return `The agent session failed${task.error ? `: ${task.error}` : "."}`;
  if (task.state === "closed") return task.handedOff ? "The session was handed off." : "The agent session was closed.";
  if (task.stopReason && task.stopReason !== "end_turn") return `The agent's turn ended with ${task.stopReason}.`;
  return "The agent's turn did not complete.";
}

/**
 * Validates dashboard work when the agent finishes a turn. One supervisor
 * follows one task: every completed turn is validated, and the single
 * automatic repair is a follow-up prompt in the same session so the agent
 * keeps its context.
 */
export class DashboardSetupSupervisor {
  private repairAttempted = false;
  /** The current turn is the automatic repair. */
  private repairing = false;
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
    const { location } = this.options;
    if (this.approvedPermissions.size === 0) {
      for (const permission of node.manifest?.permissions ?? []) this.approvedPermissions.add(permission);
    }
    const configPath = node.sourceConfigPath ?? location.configPath;
    const prompt = starterAgentPrompt(basename(location.projectRoot) || "Project", configPath);
    return this.launchRequest({ prompt, configPath, componentPath: componentPath(node), request: "Set up this dashboard", purpose: "setup" });
  }

  /**
   * Launch one request. `followUp: false` skips dashboard validation and
   * repair, for project work. `untrustedRepair` starts the request without a
   * trust grant and without the project-controlled bundle environment: it
   * requires the caller to supply a clean `env`, never calls the trust-gated
   * launch environment, refuses out-of-bundle permission requests, and
   * reports review-required instead of repairing.
   */
  async launchRequest(request: { prompt: string; configPath: string; componentPath: string; request: string; purpose?: AgentSessionTask["purpose"]; template?: string; followUp?: boolean; untrustedRepair?: boolean; env?: Record<string, string> }): Promise<ComponentAgentLaunch> {
    const { runtime, harness, command, location, preflight } = this.options;
    const { followUp = true, untrustedRepair = false, env: explicitEnv, ...launch } = request;
    const env = explicitEnv ?? await runtime.getLaunchEnvironment(request.configPath);
    preflight?.(command, env, location.projectRoot);
    if (!this.stillHere() || (!untrustedRepair && !runtime.getSnapshot().trusted)) {
      throw new Error("The active dashboard or its trust changed before agent work started.");
    }
    return harness.launch({
      ...launch,
      command,
      projectRoot: location.projectRoot,
      bundleDirectory: location.configDirectory,
      env,
      ...(untrustedRepair ? { untrusted: true } : {}),
      ...(followUp ? { onTurnEnd: (task: AgentSessionTask) => this.finish(task, request.configPath) } : {}),
    });
  }

  private async finish(task: AgentSessionTask, configPath: string): Promise<void> {
    const repair = this.repairing;
    this.repairing = false;
    const { runtime, harness, location } = this.options;
    const cancelled = () => task.cancelled === true || harness.isCancelled?.(task.id) === true;
    const report = (status: Validation["status"], diagnostics: Diagnostic[], message?: string) => {
      const validation = { status, diagnostics, ...(message ? { message } : {}) };
      harness.setValidation(task.id, validation);
      this.options.onValidation?.(validation);
    };
    report("checking", [], "Checking saved configuration and local components…");
    try {
      const fresh = await loadProjectDefinition(location, { compile: true });
      const diagnostics = structuredClone(fresh.diagnostics);
      if (cancelled() || !this.stillHere()) {
        report("cancelled", diagnostics, "Agent work was stopped; no automatic repair will run.");
        return;
      }
      const additionalPermissions = fresh.permissions.filter((permission) => !this.approvedPermissions.has(permission));
      if (additionalPermissions.length > 0) {
        // Publish the trust delta, but never grant it or prompt the agent again.
        if (!hasErrors(diagnostics)) await runtime.reload();
        report("trust-required", diagnostics, hasErrors(diagnostics)
          ? `Configuration errors remain; once fixed, review project trust for: ${additionalPermissions.join(", ")}.`
          : `Review project trust for: ${additionalPermissions.join(", ")}.`);
        return;
      }
      if (!runtime.getSnapshot().trusted) {
        report("trust-required", diagnostics, "Project trust is not enabled; review it to load this dashboard. No automatic repair will run.");
        return;
      }
      const clean = task.state === "idle" && task.stopReason === "end_turn";
      if (!clean) {
        report(cancelled() || task.stopReason === "cancelled" || task.state === "closed" ? "cancelled" : "failed", diagnostics,
          `${turnOutcome(task)} ${hasErrors(diagnostics) ? "Configuration errors remain." : "Saved configuration validates."} No automatic repair was started.`);
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
      const unrepairable = diagnostics.some((item) => item.severity === "error"
        && !REPAIRABLE.test(item.code)
        && !(task.purpose === "migration" && item.code === "CONFIG_SCHEMA_MIGRATION_REQUIRED"));
      if (repair || this.repairAttempted || unrepairable) {
        report("failed", diagnostics, repair
          ? "Configuration errors remain after the single repair attempt."
          : this.repairAttempted
            ? "Configuration errors remain; the automatic repair was already used. Ask the agent to fix them."
            : "Review these diagnostics; the automatic repair does not cover them.");
        return;
      }
      this.repairAttempted = true;
      if (cancelled() || !this.stillHere() || !runtime.getSnapshot().trusted) {
        report("cancelled", diagnostics, "Agent work was stopped before the repair.");
        return;
      }
      const repairPrompt = buildDiagnosticsAgentPrompt({ projectRoot: location.projectRoot, configPath, diagnostics, followUp: true });
      report("repairing", diagnostics, "Asking the agent for the single automatic repair.");
      this.repairing = true;
      try {
        await harness.followUp(task.id, repairPrompt);
      } catch (error) {
        this.repairing = false;
        throw error;
      }
    } catch (error) {
      report("failed", [{ severity: "error", code: "DASHBOARD_SETUP_FOLLOWUP_FAILED", message: error instanceof Error ? error.message : String(error) }], "Validation or repair could not finish. Review the error and retry when ready.");
    }
  }
}

export function findSetupNode(runtime: DashboardSetupRuntime, nodeId: string): ResolvedComponentNode | null {
  const snapshot = runtime.getSnapshot();
  const node = snapshot.tree ? findResolvedNode(snapshot.tree, nodeId) : null;
  return node?.manifest?.permissions?.includes("process:execute") ? node : null;
}
