import { CapabilityService } from "../core/capabilities";
import { errorMessage } from "../core/diagnostics";
import type { ProjectDefinition } from "../core/project";
import { definitionCapabilityContext } from "../core/project-runtime";
import type { PublishedEnvironment } from "../core/environment";
import { parseDashboardConfig } from "../core/yaml";
import { childEdges } from "../shared/child-edges";
import type { ComponentNode, NodeWatch, ProjectSnapshot, ResolvedComponentNode } from "../shared/contracts";
import { notificationLevelFor, type NotificationSettings } from "../shared/notifications";
import {
  decodeWatchSourceText,
  WATCH_LIMIT_APP,
  watchFamily,
  watchInterval,
  watchLevel,
  watchSource,
  type WatchSource,
} from "../shared/watches";
import type { NotificationCenter } from "./notification-center";
import { nodeLabel } from "./notification-producers";
import {
  evaluateWatch,
  INITIAL_WATCH_MEMORY,
  watchErrorKey,
  watchItemKey,
  watchMoreKey,
  watchPausedKey,
  watchStateKey,
  type WatchMemory,
  type WatchObservation,
  type WatchSubject,
} from "./watch-evaluation";

/** The first plan waits for startup work such as the active dashboard's load. */
export const WATCH_PLAN_START_DELAY_MS = 10_000;
/** Registered dashboards are re-read this often, catching edits made outside the app. */
export const WATCH_PLAN_INTERVAL_MS = 600_000;
/** Plan requests within this window share one plan. */
export const WATCH_PLAN_DEBOUNCE_MS = 1_000;
/** A newly planned watch first observes after this delay, plus its stagger. */
export const WATCH_FIRST_OBSERVATION_MS = 3_000;
export const WATCH_STAGGER_MS = 1_500;

export interface WatchScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: WatchScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Read one watched source with its dashboard's capabilities; throws with a short reason. */
export type WatchSourceReader = (capabilities: CapabilityService, nodeId: string, source: WatchSource) => Promise<unknown>;

/** The active dashboard as the runner needs it at planning time. */
export interface ActiveWatchContext {
  configPath: string | null;
}

export interface WatchRunnerOptions {
  center: Pick<NotificationCenter, "raise" | "resolve" | "resolvePrefix">;
  /** Registered dashboards, in sidebar order. */
  dashboards(): Promise<ReadonlyArray<{ configPath: string; dashboardName: string | null }>>;
  active(): ActiveWatchContext;
  loadDefinition(configPath: string): Promise<ProjectDefinition>;
  /** The runtime's composed trust rule, including session revocation. */
  isTrusted(definition: TrustSubject): Promise<boolean>;
  settings(): NotificationSettings;
  getPublishedEnvironment: PublishedEnvironment;
  readSource?: WatchSourceReader;
  /** The raw root of a config whose tree did not resolve, to count the watches it declares. */
  readDeclaredRoot?(configPath: string): Promise<ComponentNode | null>;
  scheduler?: WatchScheduler;
  log?(message: string, error?: unknown): void;
}

/** What the trust rule reads from a definition. */
type TrustSubject = Pick<ProjectDefinition, "trustReview" | "location" | "permissions">;

interface PlannedWatch {
  id: string;
  /** Changes when anything that defines the watch changes; a new fingerprint starts a new baseline. */
  fingerprint: string;
  subject: WatchSubject;
  source: WatchSource;
  every: number;
  memory: WatchMemory;
  /** Its timer chain is scheduled. */
  running: boolean;
  timer: unknown;
  inFlight: boolean;
  /** Bumped whenever the watch stops, so a late observation is discarded. */
  generation: number;
}

/**
 * Background watches for every registered, valid, and trusted dashboard.
 * A plan loads each dashboard's definition in turn and reconciles the
 * watches it declares; each polled watch then runs its own timer chain with
 * one observation in flight. Observations go through the pure
 * evaluation, whose decisions the notification center records and delivers.
 */
export class WatchRunner {
  private readonly scheduler: WatchScheduler;
  private readonly readSource: WatchSourceReader;
  private readonly watches = new Map<string, PlannedWatch>();
  private readonly services = new Map<string, CapabilityService>();
  /** The capability set each serving dashboard was trusted for; every read re-checks it. */
  private readonly trustSubjects = new Map<string, TrustSubject>();
  /** Open paused entries by config, with the reason they gave; a plan re-raises only a new reason. */
  private readonly paused = new Map<string, string>();
  private started = false;
  private stopped = false;
  private planning: Promise<void> | null = null;
  private replan = false;
  private planTimer: unknown = null;
  private refreshTimer: unknown = null;
  private activeConfigPath: string | null = null;
  private staggerIndex = 0;
  private lastSnapshot: { configPath: string | null; configRevision: string | null; trusted: boolean } | null = null;

  constructor(private readonly options: WatchRunnerOptions) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.readSource = options.readSource ?? readWatchSource;
  }

  /** Begin watching: the first plan runs shortly after startup, then periodically. */
  start(delayMs = WATCH_PLAN_START_DELAY_MS): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedulePlan(delayMs);
  }

  /** Stop every timer; late observations are discarded. Watching ends with the app. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of [this.planTimer, this.refreshTimer]) if (handle !== null) this.scheduler.clearTimeout(handle);
    this.planTimer = null;
    this.refreshTimer = null;
    for (const watch of this.watches.values()) this.halt(watch);
    for (const service of this.services.values()) service.configure(null);
  }

  /** Ask for a plan soon, such as after a settings or registry change; bursts share one plan. */
  requestRefresh(): void {
    if (!this.started || this.stopped || this.refreshTimer !== null) return;
    this.refreshTimer = this.scheduler.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, WATCH_PLAN_DEBOUNCE_MS);
  }

  /** Re-plan when the active dashboard, its revision, or its trust changes. */
  observeSnapshot(snapshot: Pick<ProjectSnapshot, "configPath" | "configRevision" | "trusted">): void {
    const next = { configPath: snapshot.configPath ?? null, configRevision: snapshot.configRevision, trusted: snapshot.trusted };
    this.activeConfigPath = next.configPath;
    const previous = this.lastSnapshot;
    this.lastSnapshot = next;
    if (previous && previous.configPath === next.configPath && previous.configRevision === next.configRevision
      && previous.trusted === next.trusted) return;
    this.requestRefresh();
  }

  /** Plan now; a request during a plan runs one more plan after it. */
  refresh(): Promise<void> {
    if (!this.started || this.stopped) return Promise.resolve();
    if (this.planning) {
      this.replan = true;
      return this.planning;
    }
    this.planning = (async () => {
      try {
        do {
          this.replan = false;
          await this.plan();
        } while (this.replan && !this.stopped);
      } catch (error) {
        this.log("Could not plan background watches.", error);
      } finally {
        this.planning = null;
        if (!this.stopped) this.schedulePlan(WATCH_PLAN_INTERVAL_MS);
      }
    })();
    return this.planning;
  }

  /** Watches currently running, for diagnostics and tests. */
  runningWatches(): Array<{ configPath: string; nodeId: string; every: number; source: WatchSource }> {
    return [...this.watches.values()].filter((watch) => watch.running).map((watch) => ({
      configPath: watch.subject.configPath,
      nodeId: watch.subject.nodeId,
      every: watch.every,
      source: { ...watch.source },
    }));
  }

  private schedulePlan(delayMs: number): void {
    if (this.planTimer !== null) this.scheduler.clearTimeout(this.planTimer);
    this.planTimer = this.scheduler.setTimeout(() => {
      this.planTimer = null;
      void this.refresh();
    }, delayMs);
  }

  private async plan(): Promise<void> {
    const settings = this.options.settings();
    if (settings.watches === false) {
      this.disable();
      return;
    }
    const registered = await this.options.dashboards();
    const active = this.options.active();
    this.activeConfigPath = active.configPath;
    const names = new Map(registered.map((dashboard) => [dashboard.configPath, dashboard.dashboardName]));
    const configPaths = [...new Set([...registered.map((dashboard) => dashboard.configPath), ...active.configPath ? [active.configPath] : []])];
    const desired = new Map<string, PlannedWatch>();
    /** Configs whose watches pause: their memory survives until they run again. */
    const held = new Set<string>();
    const planned = new Set<string>();
    let budget = WATCH_LIMIT_APP;

    for (const requested of configPaths) {
      if (this.stopped) return;
      let definition: ProjectDefinition;
      try {
        definition = await this.options.loadDefinition(requested);
      } catch (error) {
        this.log(`Could not load ${requested} for background watches.`, error);
        held.add(requested);
        planned.add(requested);
        continue;
      }
      const configPath = definition.location.configPath;
      planned.add(configPath);
      const dashboardName = definition.config?.name ?? names.get(requested) ?? null;
      if (notificationLevelFor(settings, configPath) === "off") {
        // A muted dashboard reports nothing, so its watches need not run.
        held.add(configPath);
        this.options.center.resolve(watchPausedKey(configPath));
        continue;
      }
      const tree = definition.ok ? definition.tree : null;
      let trusted = false;
      if (tree) {
        try {
          trusted = await this.options.isTrusted(definition);
        } catch (error) {
          this.log(`Could not read trust for ${configPath}.`, error);
        }
      }
      if (!tree || !trusted) {
        held.add(configPath);
        const declared = tree ? ownWatchedNodes(tree, configPath).length : await this.declaredWatchCount(definition);
        if (declared === 0) this.resolvePaused(configPath);
        else this.raisePaused(configPath, dashboardName, tree
          ? `${countWatches(declared)} paused: review and trust this dashboard to run ${declared === 1 ? "it" : "them"}.`
          : `${countWatches(declared)} paused: fix this dashboard's configuration errors to run ${declared === 1 ? "it" : "them"}.`);
        continue;
      }
      const nodes = ownWatchedNodes(tree, configPath);
      const admitted = nodes.slice(0, Math.max(0, budget));
      budget -= admitted.length;
      if (admitted.length < nodes.length) {
        held.add(configPath);
        this.raisePaused(configPath, dashboardName,
          `${nodes.length - admitted.length} of ${countWatches(nodes.length)} paused: dash-bored runs at most ${WATCH_LIMIT_APP} watches at once.`);
      } else {
        this.resolvePaused(configPath);
      }
      if (admitted.length === 0) continue;
      const service = this.services.get(configPath) ?? new CapabilityService();
      service.configure(definitionCapabilityContext(definition, tree, true, this.options.getPublishedEnvironment));
      this.services.set(configPath, service);
      this.trustSubjects.set(configPath, { trustReview: definition.trustReview, location: definition.location, permissions: definition.permissions });
      for (const node of admitted) {
        const watch = plannedWatch(node, tree, configPath, dashboardName);
        if (watch) desired.set(watch.id, watch);
      }
    }
    if (this.stopped) return;
    this.reconcile(desired, held);
    for (const configPath of [...this.paused.keys()]) if (!planned.has(configPath)) this.resolvePaused(configPath);
    const serving = new Set([...this.watches.values()].filter((watch) => watch.running).map((watch) => watch.subject.configPath));
    for (const configPath of [...this.services.keys()]) {
      if (!serving.has(configPath)) {
        this.services.get(configPath)?.configure(null);
        this.services.delete(configPath);
        this.trustSubjects.delete(configPath);
      }
    }
  }

  private reconcile(desired: Map<string, PlannedWatch>, held: ReadonlySet<string>): void {
    for (const [id, existing] of this.watches) {
      const next = desired.get(id);
      if (next && next.fingerprint === existing.fingerprint) {
        existing.subject = next.subject;
        desired.delete(id);
        if (!existing.running) this.begin(existing, this.firstDelay());
        continue;
      }
      this.halt(existing);
      if (!next && held.has(existing.subject.configPath)) {
        // Paused: keep the baseline, but a failing streak is no longer being observed.
        if (existing.memory.failing) {
          this.options.center.resolve(watchErrorKey(existing.subject.configPath, existing.subject.nodeId));
          existing.memory = { ...existing.memory, failing: false };
        }
        continue;
      }
      // Removed or redefined: its open decisions described the earlier watch.
      this.resolveAll(existing);
      this.watches.delete(id);
    }
    for (const watch of desired.values()) {
      this.watches.set(watch.id, watch);
      this.begin(watch, this.firstDelay());
    }
  }

  private firstDelay(): number {
    return WATCH_FIRST_OBSERVATION_MS + (this.staggerIndex++ % WATCH_LIMIT_APP) * WATCH_STAGGER_MS;
  }

  private begin(watch: PlannedWatch, delayMs: number): void {
    watch.running = true;
    this.schedule(watch, delayMs);
  }

  private halt(watch: PlannedWatch): void {
    watch.running = false;
    watch.generation += 1;
    if (watch.timer !== null) this.scheduler.clearTimeout(watch.timer);
    watch.timer = null;
  }

  private schedule(watch: PlannedWatch, delayMs: number): void {
    if (watch.timer !== null) this.scheduler.clearTimeout(watch.timer);
    watch.timer = this.scheduler.setTimeout(() => {
      watch.timer = null;
      void this.observe(watch);
    }, delayMs);
  }

  private async observe(watch: PlannedWatch): Promise<void> {
    if (this.stopped || !watch.running) return;
    if (watch.inFlight) {
      // The previous chain's read is still out; skip this tick rather than overlap it.
      this.schedule(watch, watch.every);
      return;
    }
    const service = this.services.get(watch.subject.configPath);
    if (!service) return;
    const generation = watch.generation;
    watch.inFlight = true;
    let observation: WatchObservation;
    try {
      // A plan can be minutes old: never run project code for a dashboard that
      // left the registry or lost trust since, even before the next plan.
      if (!await this.mayRun(watch.subject.configPath)) {
        if (generation === watch.generation) this.halt(watch);
        this.requestRefresh();
        return;
      }
      if (generation !== watch.generation) return;
      observation = { ok: true, value: await this.readSource(service, watch.subject.nodeId, watch.source) };
    } catch (error) {
      observation = { ok: false, error: errorMessage(error) };
    } finally {
      watch.inFlight = false;
    }
    if (this.stopped || generation !== watch.generation || this.watches.get(watch.id) !== watch) return;
    this.apply(watch, observation);
    // Timers chain from completion, so a sleeping machine wakes to one observation, not a burst.
    this.schedule(watch, watch.every);
  }

  private async mayRun(configPath: string): Promise<boolean> {
    const subject = this.trustSubjects.get(configPath);
    if (!subject || this.options.settings().watches === false) return false;
    try {
      const registered = (await this.options.dashboards()).some((dashboard) => dashboard.configPath === configPath)
        || this.activeConfigPath === configPath;
      return registered && await this.options.isTrusted(subject);
    } catch (error) {
      this.log(`Could not confirm trust for ${configPath}.`, error);
      return false;
    }
  }

  private apply(watch: PlannedWatch, observation: WatchObservation): void {
    const decision = evaluateWatch(watch.subject, watch.memory, observation);
    watch.memory = decision.memory;
    if (decision.resolve.length > 0) this.options.center.resolve(decision.resolve);
    for (const raise of decision.raise) this.options.center.raise(raise);
  }

  private resolveAll(watch: PlannedWatch): void {
    const { configPath, nodeId } = watch.subject;
    this.options.center.resolve([watchStateKey(configPath, nodeId), watchMoreKey(configPath, nodeId), watchErrorKey(configPath, nodeId)]);
    this.options.center.resolvePrefix(watchItemKey(configPath, nodeId, ""));
  }

  /** Watching was switched off: stop everything; switching it on starts from new baselines. */
  private disable(): void {
    for (const watch of this.watches.values()) {
      this.halt(watch);
      this.options.center.resolve(watchErrorKey(watch.subject.configPath, watch.subject.nodeId));
    }
    this.watches.clear();
    for (const service of this.services.values()) service.configure(null);
    this.services.clear();
    this.trustSubjects.clear();
    for (const configPath of [...this.paused.keys()]) this.resolvePaused(configPath);
  }

  private raisePaused(configPath: string, dashboardName: string | null, message: string): void {
    // Planning repeats; a dismissed or unchanged reason is not news.
    if (this.paused.get(configPath) === message) return;
    this.paused.set(configPath, message);
    this.options.center.raise({
      key: watchPausedKey(configPath),
      kind: "watch-paused",
      level: "inform",
      configPath,
      dashboardName,
      title: "Watches paused",
      message,
      target: { kind: "dashboard" },
    });
  }

  private resolvePaused(configPath: string): void {
    this.paused.delete(configPath);
    this.options.center.resolve(watchPausedKey(configPath));
  }

  private async declaredWatchCount(definition: ProjectDefinition): Promise<number> {
    let root: ComponentNode | null = definition.config?.root ?? null;
    if (!root) {
      try {
        root = await (this.options.readDeclaredRoot ?? readDeclaredRoot)(definition.location.configPath);
      } catch {
        root = null;
      }
    }
    if (!root) return 0;
    let count = 0;
    const visit = (node: ComponentNode): void => {
      if (node.watch !== undefined) count += 1;
      for (const edge of childEdges(node.children)) visit(edge.node);
    };
    visit(root);
    return count;
  }

  private log(message: string, error?: unknown): void {
    if (this.options.log) this.options.log(message, error);
    else console.error(message, error);
  }
}

function countWatches(count: number): string {
  return `${count} watch${count === 1 ? "" : "es"}`;
}

/** Watched nodes the bundle at `configPath` owns; a linked bundle runs its own when it is registered. */
function ownWatchedNodes(tree: ResolvedComponentNode, configPath: string): ResolvedComponentNode[] {
  const nodes: ResolvedComponentNode[] = [];
  const visit = (node: ResolvedComponentNode): void => {
    if (node.watch !== undefined && (node.sourceConfigPath ?? configPath) === configPath) nodes.push(node);
    for (const edge of childEdges(node.children)) visit(edge.node);
  };
  visit(tree);
  return nodes;
}

function plannedWatch(
  node: ResolvedComponentNode,
  tree: ResolvedComponentNode,
  configPath: string,
  dashboardName: string | null,
): PlannedWatch | null {
  const watch = node.watch as NodeWatch;
  const family = watchFamily(watch.on);
  const resolved = watchSource(node.props, node.manifest?.resources?.observation);
  // Validation rejects both; a resolved tree never carries them.
  if (!family || family !== node.manifest?.resources?.observation?.kind || "error" in resolved) return null;
  const label = nodeLabel(tree, node.id);
  return {
    id: `${configPath}\0${node.id}`,
    fingerprint: JSON.stringify({ watch, source: resolved.source, label }),
    subject: {
      configPath,
      dashboardName,
      nodeId: node.id,
      label,
      family,
      on: [...watch.on],
      level: watchLevel(watch, family),
      ...(watch.action ? { action: structuredClone(watch.action) } : {}),
    },
    source: resolved.source,
    every: watchInterval(watch),
    memory: INITIAL_WATCH_MEMORY,
    running: false,
    timer: null,
    inFlight: false,
    generation: 0,
  };
}

async function readDeclaredRoot(configPath: string): Promise<ComponentNode | null> {
  return (await parseDashboardConfig(configPath)).trustConfig?.root ?? null;
}

/**
 * Read a watched source the way the core views do: a command must exit 0 and
 * its stdout is JSON when it parses, a file is read as text, and an HTTP
 * response must be 2xx. The node's own permissions and bounds apply.
 */
export async function readWatchSource(capabilities: CapabilityService, nodeId: string, source: WatchSource): Promise<unknown> {
  switch (source.kind) {
    case "shell": {
      const result = await capabilities.runShell({
        nodeId,
        command: source.value,
        ...(source.cwd === undefined ? {} : { cwd: source.cwd }),
        ...(source.env === undefined ? {} : { env: source.env }),
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
      });
      if (result.timedOut || result.exitCode !== 0) {
        const reason = result.timedOut ? "timed out" : result.exitCode === null ? `stopped by ${result.signal ?? "a signal"}` : `exit ${result.exitCode}`;
        const stderr = result.stderr.trim().slice(-500);
        throw new Error(`Command failed (${reason})${stderr ? `: ${stderr}` : "."}`);
      }
      return decodeWatchSourceText(result.stdout);
    }
    case "file":
      return decodeWatchSourceText(await capabilities.readText({ nodeId, path: source.value }));
    case "http": {
      const response = await capabilities.http({
        nodeId,
        url: source.value,
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
      });
      if (response.status < 200 || response.status >= 300) {
        const body = response.body.trim().slice(-500);
        throw new Error(`HTTP ${response.status}${body ? `: ${body}` : "."}`);
      }
      return decodeWatchSourceText(response.body);
    }
  }
}
