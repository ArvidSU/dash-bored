import { CoreError, errorMessage, updateComponent } from "../core/index";
import { checkPackageUpdates, preferredTag, type PackageUpdateSource } from "../core/package-updates";
import { readRemoteHeadAndTags, type RemoteHeadAndTags } from "../core/package-store";
import { updateTheme } from "../core/theme-install";
import type { ProjectListItem, ProjectSnapshot } from "../shared/contracts";
import {
  INITIAL_PACKAGE_UPDATE_STATE,
  packageVersionLabel,
  type PackageUpdateCommand,
  type PackageUpdateItem,
  type PackageUpdateState,
  type PackageVersion,
} from "../shared/package-updates";

export interface PackageUpdatesOptions {
  registry: { list(): Promise<ProjectListItem[]> };
  runtime: { getSnapshot(): ProjectSnapshot; reload(): Promise<unknown> };
  /** Pushes a fresh theme catalog after a theme pin moves. */
  publishThemes(): Promise<void>;
  /** Pushes every state change to the renderer. */
  onChange(state: PackageUpdateState): void;
  /** The app's update-check preference, which also governs package checks. */
  automaticChecks(): Promise<boolean>;
  personalDirectory?: string;
  readRemote?: (url: string) => Promise<RemoteHeadAndTags>;
  updateComponent?: (configPath: string, name: string) => Promise<{ commit: string }>;
  updateTheme?: (target: { project?: string; global?: boolean; globalDirectory?: string }, name: string) => Promise<{ commit: string }>;
}

const STARTUP_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

function ownerLabel(item: PackageUpdateItem): string {
  return item.configPath === null ? "personal themes" : item.dashboardName?.trim() || item.configPath;
}

/**
 * Package update state for Settings. Checks and updates run one at a time in
 * the background; every step reaches the renderer through `onChange`, so a
 * command answers as soon as its work has started.
 */
export function createPackageUpdates(options: PackageUpdatesOptions) {
  const readRemote = options.readRemote ?? readRemoteHeadAndTags;
  const moveComponent = options.updateComponent ?? ((configPath: string, name: string) => updateComponent(configPath, name));
  const moveTheme = options.updateTheme ?? ((target: Parameters<typeof updateTheme>[0], name: string) => updateTheme(target, name));
  let state: PackageUpdateState = { ...INITIAL_PACKAGE_UPDATE_STATE };
  let running: Promise<void> | null = null;
  /** Remote heads from the last check, so a local pin change can be re-rated without the network. */
  let remotes = new Map<string, Promise<RemoteHeadAndTags>>();

  const set = (patch: Partial<PackageUpdateState>): void => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const replace = (id: string, patch: Partial<PackageUpdateItem>): void => {
    set({ packages: state.packages.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      for (const key of Object.keys(patch) as (keyof PackageUpdateItem)[]) if (patch[key] === undefined) delete next[key];
      return next;
    }) });
  };

  async function sources(): Promise<PackageUpdateSource[]> {
    const owners = new Map<string, PackageUpdateSource>();
    for (const project of await options.registry.list()) {
      owners.set(project.configPath, { configPath: project.configPath, dashboardName: project.dashboardName });
    }
    const active = options.runtime.getSnapshot();
    if (active.configPath && !owners.has(active.configPath)) {
      owners.set(active.configPath, { configPath: active.configPath, dashboardName: active.dashboardName });
    }
    return [...owners.values(), { configPath: null }];
  }

  function start(work: () => Promise<void>): void {
    running = work().finally(() => { running = null; });
  }

  async function check(useCache: boolean): Promise<void> {
    set({ phase: "checking", problem: "" });
    try {
      const next = useCache ? remotes : new Map<string, Promise<RemoteHeadAndTags>>();
      const result = await checkPackageUpdates(await sources(), {
        ...options.personalDirectory ? { personalDirectory: options.personalDirectory } : {},
        readRemote: (url) => {
          if (!next.has(url)) next.set(url, readRemote(url));
          return next.get(url)!;
        },
      });
      remotes = next;
      // The panel words the result from the packages; `message` reports updates.
      set({
        phase: "idle",
        checkedAt: useCache && state.checkedAt ? state.checkedAt : new Date().toISOString(),
        packages: result.packages,
        message: "",
        problem: result.problems.join(" "),
      });
    } catch (error) {
      set({ phase: "idle", problem: `Package check failed: ${errorMessage(error)}` });
    }
  }

  async function update(targets: PackageUpdateItem[]): Promise<void> {
    set({ phase: "updating", updating: targets.map((item) => item.id), problem: "", message: "" });
    const active = options.runtime.getSnapshot();
    let reloadActive = false;
    let themesChanged = false;
    const updated: string[] = [];
    const failed: string[] = [];
    for (const item of targets) {
      try {
        const { commit } = item.kind === "component"
          ? await moveComponent(item.configPath!, item.name)
          : await moveTheme(item.configPath === null
              ? { global: true, ...options.personalDirectory ? { globalDirectory: options.personalDirectory } : {} }
              : { project: item.configPath }, item.name);
        const resolved = commit.toLowerCase();
        // The update resolved the remote head again; reuse the checked tag when it is the same commit.
        const tag = item.latest?.commit === resolved ? item.latest.tag
          : preferredTag((await remotes.get(item.url)?.catch(() => undefined))?.tags.get(resolved));
        const version: PackageVersion = { commit: resolved, ...tag ? { tag } : {} };
        replace(item.id, { current: version, latest: version, status: "current", error: undefined, changesUrl: undefined });
        updated.push(`${item.name} to ${packageVersionLabel(version)}`);
        if (item.kind === "theme") themesChanged = true;
        else if (item.configPath === active.configPath) reloadActive = true;
      } catch (error) {
        replace(item.id, { error: errorMessage(error) });
        failed.push(`${item.name} (${ownerLabel(item)})`);
      }
      set({ updating: state.updating.filter((id) => id !== item.id) });
    }
    const notes: string[] = [];
    if (reloadActive) {
      try {
        // A reload re-runs the permission-union trust check for the new pins.
        await options.runtime.reload();
        if (active.trusted && !options.runtime.getSnapshot().trusted) {
          notes.push("The open dashboard asks for trust again because the update requests new permissions.");
        }
      } catch (error) {
        notes.push(`Reload the dashboard to use the update: ${errorMessage(error)}`);
      }
    }
    if (themesChanged) await options.publishThemes().catch((error: unknown) => notes.push(`Themes refresh after a reload: ${errorMessage(error)}`));
    set({
      phase: "idle",
      updating: [],
      message: [updated.length === 1 ? `Updated ${updated[0]}.` : updated.length ? `Updated ${updated.length} packages.` : "", ...notes].filter(Boolean).join(" "),
      problem: failed.length ? `Could not update ${failed.join(", ")}.` : "",
    });
  }

  return {
    state: (): PackageUpdateState => state,

    /** Starts a check or update and answers once it has started. */
    async command(command: PackageUpdateCommand): Promise<void> {
      if (running) throw new CoreError("PACKAGE_UPDATE_ACTIVE", "A package check or update is already running.");
      if (command.type === "check") {
        start(() => check(false));
        return;
      }
      const wanted = new Set(command.ids);
      const targets = state.packages.filter((item) => wanted.has(item.id) && item.status === "available" && !item.blocked);
      if (targets.length === 0) throw new CoreError("PACKAGE_UPDATE_NONE", "No selected package can be updated. Check for package updates again.");
      start(() => update(targets));
    },

    /** Re-rates pins after a manual package operation, reusing the last check's remote heads. */
    refresh(): void {
      if (running || state.checkedAt === null) return;
      start(() => check(true));
    },

    /** Resolves when the running check or update has finished. */
    idle: (): Promise<void> => running ?? Promise.resolve(),

    /** Startup and daily checks while the app's automatic update checks are on. */
    schedule(): void {
      const scheduled = async () => {
        if (running || !(await options.automaticChecks())) return;
        start(() => check(false));
      };
      const log = (error: unknown) => console.error("Package update check failed:", error);
      setTimeout(() => void scheduled().catch(log), STARTUP_CHECK_DELAY_MS);
      setInterval(() => void scheduled().catch(log), CHECK_INTERVAL_MS);
    },
  };
}

export type PackageUpdates = ReturnType<typeof createPackageUpdates>;
