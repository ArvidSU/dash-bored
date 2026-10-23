import { declaredComponentLabel } from "../shared/component-label";
import { agentTaskSummary, isAgentTaskBusy, type AgentSessionTask } from "../shared/agent-session";
import { childEdges } from "../shared/child-edges";
import { findResolvedNode } from "../shared/component-agent";
import type { ProcessSnapshot, ResolvedComponentNode } from "../shared/contracts";
import { updatablePackages, type PackageUpdateState } from "../shared/package-updates";
import { processRun, processRunFailed, processRunOutcome } from "../shared/process-state";
import { compareVersions, type UpdateState } from "../shared/updates";
import type { NotificationCenter } from "./notification-center";

/** A successful run shorter than this finished while the user was still at it; only failures notify. */
export const RUN_FINISHED_MIN_MS = 10_000;
/** Ends by an interrupt typed into the terminal or a kill from outside: the signal, or the shell's 128+n exit code. */
const STOP_SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGKILL", "SIGTERM"]);
const STOP_EXIT_CODES = new Set([129, 130, 137, 143]);

/** The label a node shows: its title or label prop, the panel label on its edge, its manifest name, else its ID. */
export function nodeLabel(tree: ResolvedComponentNode | null | undefined, nodeId: string): string {
  if (!tree) return nodeId;
  const node = findResolvedNode(tree, nodeId);
  if (!node) return nodeId;
  const caption = declaredComponentLabel(node);
  if (caption) return caption;
  const edgeLabel = parentEdgeLabel(tree, nodeId);
  return edgeLabel ?? node.configName?.trim() ?? node.manifest?.name ?? nodeId;
}

function parentEdgeLabel(node: ResolvedComponentNode, nodeId: string): string | undefined {
  for (const edge of childEdges(node.children)) {
    if (edge.node.id === nodeId) {
      const label = edge.metadata?.label;
      return typeof label === "string" && label.trim() ? label.trim() : undefined;
    }
    const found = parentEdgeLabel(edge.node, nodeId);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface ActiveDashboard {
  configPath: string | null;
  dashboardName: string | null;
  tree: ResolvedComponentNode | null;
}

interface TrackedRun {
  startedAt: string;
  finished: boolean;
  /** Started from the agent control channel; agents report their own results. */
  agent: boolean;
  /** Passed through `stopping`: the user or the app ended it. */
  stopped: boolean;
}

/**
 * Supervised runs of the active dashboard. A run the user started that fails,
 * or finishes after running long enough that they moved on, raises a
 * decision; starting the node again supersedes it.
 */
export class RunNotifications {
  private readonly runs = new Map<string, TrackedRun>();
  private readonly pending = new Map<string, { agent: boolean }>();

  constructor(
    private readonly center: NotificationCenter,
    private readonly active: () => ActiveDashboard,
  ) {}

  /** A start or quick action is about to run on `nodeId`. */
  noteStart(nodeId: string, agent: boolean): void {
    this.pending.set(this.key(nodeId), { agent });
  }

  observe(snapshot: ProcessSnapshot): void {
    const { configPath, dashboardName, tree } = this.active();
    if (!configPath) return;
    const run = processRun(snapshot);
    if (!run) return;
    const key = this.key(snapshot.id);
    let tracked = this.runs.get(key);
    if (!tracked || tracked.startedAt !== run.startedAt) {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      tracked = { startedAt: run.startedAt, finished: false, agent: pending?.agent ?? false, stopped: false };
      this.runs.set(key, tracked);
      // A new run supersedes the decision about the previous one.
      this.center.resolve(this.notificationKey(configPath, snapshot.id));
    }
    // The process manager passes every requested stop (the user's, a dashboard
    // switch, a trust change, quit) through `stopping`; such an end is not news.
    if (run.phase === "stopping") tracked.stopped = true;
    if (tracked.finished || run.phase === "running" || run.phase === "stopping") return;
    tracked.finished = true;
    if (tracked.agent || tracked.stopped) return;
    if ((run.signal !== null && STOP_SIGNALS.has(run.signal)) || (run.exitCode !== null && STOP_EXIT_CODES.has(run.exitCode))) return;
    const failed = processRunFailed(run);
    const duration = run.durationMs ?? 0;
    if (!failed && duration < RUN_FINISHED_MIN_MS) return;
    const label = nodeLabel(tree, snapshot.id);
    this.center.raise({
      key: this.notificationKey(configPath, snapshot.id),
      kind: failed ? "run-failed" : "run-finished",
      level: "interrupt",
      configPath,
      dashboardName,
      title: failed ? `${label} failed` : `${label} finished`,
      message: failed
        ? `${capitalize(processRunOutcome(run))}${duration ? ` after ${formatDuration(duration)}` : ""}.`
        : `Finished after ${formatDuration(duration)}.`,
      target: { kind: "node", nodeId: snapshot.id },
      ...(failed ? {
        action: {
          label: "Fix with agent",
          invocation: {
            run: "agent:prompt",
            with: {
              prompt: `The ${label} command (node ${snapshot.id}) failed with ${processRunOutcome(run)}. Read its output, find the cause, and fix it.`,
            },
          },
        },
      } : {}),
    });
  }

  private key(nodeId: string): string {
    return `${this.active().configPath ?? ""}\0${nodeId}`;
  }

  private notificationKey(configPath: string, nodeId: string): string {
    return `run:${configPath}:${nodeId}`;
  }
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

interface TrackedTask {
  state: AgentSessionTask["state"];
  busy: boolean;
}

/**
 * Agent work belongs to the user who dispatched it, so its decisions follow
 * them across dashboards: a blocked session, a finished turn, or a failure.
 */
export class AgentNotifications {
  private readonly tasks = new Map<string, TrackedTask>();

  constructor(
    private readonly center: NotificationCenter,
    private readonly dashboardName: (configPath: string) => string | null,
  ) {}

  observe(task: AgentSessionTask): void {
    const previous = this.tasks.get(task.id);
    const busy = isAgentTaskBusy(task);
    this.tasks.set(task.id, { state: task.state, busy });
    const needsKey = `agent:${task.id}:needs`;
    const outcomeKey = `agent:${task.id}:outcome`;
    if (task.state === "closed" || task.handedOff) {
      this.center.resolvePrefix(`agent:${task.id}:`);
      this.tasks.delete(task.id);
      return;
    }
    const base = {
      configPath: task.configPath,
      dashboardName: this.dashboardName(task.configPath),
      target: { kind: "agent-session" as const, taskId: task.id },
    };
    const summary = agentTaskSummary(task);
    const needsUser = task.state === "waiting" || task.state === "auth-required";
    if (needsUser && previous?.state !== task.state) {
      this.center.raise({
        ...base,
        key: needsKey,
        kind: "agent-needs-you",
        level: "interrupt",
        title: task.state === "waiting" ? `${task.agent.name} needs permission` : `Sign in to ${task.agent.name}`,
        message: task.state === "waiting" && task.permission ? task.permission.title : summary,
      });
    } else if (!needsUser) {
      this.center.resolve(needsKey);
    }
    if (busy) {
      // Work resumed: the earlier outcome is no longer the latest word.
      if (previous && !previous.busy) this.center.resolve(outcomeKey);
      return;
    }
    if (!previous?.busy || task.cancelled) return;
    const failed = task.state === "failed" || task.validation?.status === "failed";
    this.center.raise({
      ...base,
      key: outcomeKey,
      kind: failed ? "agent-failed" : "agent-finished",
      level: "interrupt",
      title: failed ? `${task.agent.name} failed` : `${task.agent.name} finished`,
      message: failed ? task.validation?.message ?? task.error ?? summary : summary,
    });
  }
}

/** Newly updatable component and theme packages: worth knowing, never an interruption. */
export class PackageUpdateNotifications {
  private checkedAt: string | null = null;

  constructor(private readonly center: NotificationCenter) {}

  observe(state: PackageUpdateState): void {
    if (state.phase !== "idle" || state.checkedAt === this.checkedAt) return;
    this.checkedAt = state.checkedAt;
    const available = updatablePackages(state);
    if (available.length === 0) {
      this.center.resolve("package-updates");
      return;
    }
    const names = available.map((item) => item.name);
    this.center.raise({
      key: "package-updates",
      kind: "package-updates",
      level: "inform",
      configPath: null,
      dashboardName: null,
      title: available.length === 1 ? "A package update is available" : `${available.length} package updates are available`,
      message: names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`,
      target: { kind: "updates" },
    });
  }
}

/** A newer app release interrupts once per version; installing it closes the decision. */
export class ReleaseNotifications {
  constructor(
    private readonly center: NotificationCenter,
    private readonly memory: { notified(): Promise<string | null>; remember(version: string): Promise<void> },
  ) {}

  async observe(state: UpdateState): Promise<void> {
    const version = state.release?.metadata.version;
    if (!version || compareVersions(version, state.currentVersion) <= 0) {
      this.center.resolve("app-release");
      return;
    }
    const notified = await this.memory.notified();
    this.center.raise({
      key: "app-release",
      kind: "app-release",
      level: "interrupt",
      configPath: null,
      dashboardName: null,
      title: `dash-bored ${version} is available`,
      message: `You have ${state.currentVersion}. Review the release notes and install when your work allows.`,
      target: { kind: "updates" },
      quiet: notified === version,
    });
    if (notified !== version) await this.memory.remember(version);
  }
}
