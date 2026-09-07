import { watch as watchFileSystem, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CompiledLocalComponent,
  ComponentEnvironmentSnapshot,
  ComponentPropsValidation,
  DashboardConfig,
  DashboardConfigSource,
  DashboardDraftValidation,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ProcessSnapshot,
  ProjectSnapshot,
  ResolvedComponentNode,
  ShellRunRequest,
  ShellRunResult,
} from "../shared/contracts";
import { CapabilityService } from "./capabilities";
import { compileLocalComponents } from "./compiler";
import { CoreError, diagnostic, errorMessage, hasErrors } from "./diagnostics";
import type { ProjectLocation } from "./paths";
import { resolveProjectLocation } from "./paths";
import { ensureProjectFiles, replaceDashboardConfigAtomic } from "./project-files";
import {
  loadProjectDefinition,
  readConfigRevision,
  validateProjectConfigDraft,
  type ProjectDefinition,
} from "./project";
import { ProcessManager, type ProcessDefinition } from "./process-manager";
import { TrustStore } from "./trust";
import { validatePropsSchema } from "./yaml";
import { environmentSnapshot, readBundleEnvironment, resolveEnvironment, type PublishedEnvironment } from "./environment";

const DEFAULT_WATCH_DEBOUNCE_MS = 120;

/**
 * Submodule checkouts keep their git internals below the watched bundle
 * directory (a `.git` file or directory inside components/external/<name>).
 * Those internals churn on every fetch/checkout without changing the rendered
 * dashboard, so the watcher skips them but keeps watching working-tree files.
 */
function isGitInternalPath(filename: string): boolean {
  return filename.split(/[\\/]/).some((segment) => segment === ".git" || segment.startsWith(".theme-"));
}

export interface ProjectRuntimeOptions {
  trustStore: TrustStore;
  /** Allows app-level settings to inspect and edit another registered dashboard without opening it. */
  isConfigRegistered?: (configPath: string) => Promise<boolean> | boolean;
  onSnapshot?: (snapshot: ProjectSnapshot) => void;
  onProcess?: (snapshot: ProcessSnapshot) => void;
  watchDebounceMs?: number;
  getPublishedEnvironment?: PublishedEnvironment;
}

export interface LoadProjectOptions {
  inputKind?: "auto" | "project-root";
}

function emptySnapshot(): ProjectSnapshot {
  return {
    projectRoot: null,
    configPath: null,
    dashboardName: null,
    iconDataUrl: null,
    config: null,
    configRevision: null,
    componentCatalog: [],
    trusted: false,
    requestedPermissions: [],
    tree: null,
    components: [],
    processes: [],
    diagnostics: [],
    revision: 0,
  };
}

function processDefinitions(
  tree: ResolvedComponentNode,
  projectRootsByNode: ReadonlyMap<string, string>,
): ProcessDefinition[] {
  const definitions: ProcessDefinition[] = [];
  const visit = (node: ResolvedComponentNode): void => {
    const resource = node.manifest?.resources?.process;
    if (resource) {
      const command = node.props[resource.commandProp];
      const cwd = resource.cwdProp === undefined ? undefined : node.props[resource.cwdProp];
      const env = resource.envProp === undefined ? undefined : node.props[resource.envProp];
      definitions.push({
        id: node.id,
        command: String(command),
        configPath: node.sourceConfigPath,
        ...(resource.interactive === true ? { interactive: true } : {}),
        ...(projectRootsByNode.get(node.id) === undefined
          ? {}
          : { projectRoot: projectRootsByNode.get(node.id) }),
        ...(typeof cwd === "string" ? { cwd } : {}),
        ...(env !== undefined
          ? { env: env as Record<string, string> }
          : {}),
      });
    }
    visitResolvedChildren(node, visit);
  };
  visit(tree);
  return definitions;
}

function visitResolvedChildren(
  node: ResolvedComponentNode,
  visit: (child: ResolvedComponentNode) => void,
): void {
  const children = node.children;
  if (children?.type === "managed") {
    for (const edge of children.items) visit(edge.node);
    return;
  }
  if (children?.type !== "tiled") return;
  const visitLayout = (layout: typeof children.layout): void => {
    if (layout.type === "child") visit(layout.child.node);
    else {
      visitLayout(layout.first);
      visitLayout(layout.second);
    }
  };
  visitLayout(children.layout);
}

function cloneSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  return structuredClone(snapshot);
}

export class ProjectRuntime {
  private readonly trustStore: TrustStore;
  private readonly isConfigRegistered?: (configPath: string) => Promise<boolean> | boolean;
  private readonly onSnapshot?: (snapshot: ProjectSnapshot) => void;
  private readonly onProcess?: (snapshot: ProcessSnapshot) => void;
  private readonly watchDebounceMs: number;
  private readonly getPublishedEnvironment: PublishedEnvironment;
  private readonly capabilities = new CapabilityService();
  private snapshot: ProjectSnapshot = emptySnapshot();
  private location: ProjectLocation | null = null;
  private processManager: ProcessManager | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly sessionRevokedRoots = new Set<string>();
  private closed = false;
  private sessionToken = 0;

  /** Invalidates deferred setup follow-ups after navigation, revocation, or quit. */
  getSessionToken(): number {
    return this.sessionToken;
  }

  constructor(options: ProjectRuntimeOptions) {
    this.trustStore = options.trustStore;
    this.isConfigRegistered = options.isConfigRegistered;
    this.onSnapshot = options.onSnapshot;
    this.onProcess = options.onProcess;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.getPublishedEnvironment = options.getPublishedEnvironment ?? (() => ({}));
  }

  private emitSnapshot(): ProjectSnapshot {
    const value = this.getSnapshot();
    try {
      this.onSnapshot?.(value);
    } catch {
      // Consumer callbacks may not break core state transitions.
    }
    return value;
  }

  private handleProcess = (processSnapshot: ProcessSnapshot): void => {
    if (this.processManager !== null) {
      this.snapshot = { ...this.snapshot, processes: this.processManager.list() };
    }
    try {
      this.onProcess?.(structuredClone(processSnapshot));
    } catch {
      // Consumer callbacks may not break process supervision.
    }
  };

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async applyDefinition(
    definition: ProjectDefinition,
    precompiled?: CompiledLocalComponent[],
  ): Promise<ProjectSnapshot> {
    if (!definition.ok || definition.tree === null || definition.config === null) {
      this.snapshot = {
        ...this.snapshot,
        projectRoot: definition.location.projectRoot,
        configPath: definition.location.configPath,
        dashboardName: this.snapshot.tree === null ? definition.config?.name ?? null : this.snapshot.dashboardName,
        iconDataUrl: null,
        config: definition.config ?? this.snapshot.config,
        configRevision: definition.configRevision,
        componentCatalog: definition.componentCatalog,
        themeCatalog: definition.themeCatalog,
        diagnostics: definition.diagnostics,
        revision: this.snapshot.revision + 1,
      };
      return this.emitSnapshot();
    }

    let trusted = false;
    try {
      trusted = await this.trustStore.isTrusted(
        definition.location.projectRoot,
        definition.permissions,
      );
      if (this.sessionRevokedRoots.has(definition.location.projectRoot)) trusted = false;
    } catch (error) {
      definition.diagnostics.push(
        diagnostic({ code: "TRUST_STORE_READ_FAILED", message: errorMessage(error) }),
      );
    }

    let compiledComponents = precompiled ?? definition.compiledComponents;
    if (trusted) {
      if (precompiled === undefined) {
        const compiled = await compileLocalComponents(definition.localComponents);
        definition.diagnostics.push(...compiled.diagnostics);
        if (hasErrors(compiled.diagnostics)) {
          this.snapshot = {
            ...this.snapshot,
            projectRoot: definition.location.projectRoot,
            configPath: definition.location.configPath,
            dashboardName: definition.config.name,
            iconDataUrl: await this.resolveProjectIcon(definition, trusted),
            config: definition.config,
            configRevision: definition.configRevision,
            componentCatalog: definition.componentCatalog,
        themeCatalog: definition.themeCatalog,
            diagnostics: definition.diagnostics,
            revision: this.snapshot.revision + 1,
          };
          return this.emitSnapshot();
        }
        compiledComponents = compiled.components;
      }
    }

    if (this.processManager === null) {
      this.processManager = new ProcessManager({
        projectRoot: definition.location.projectRoot,
        onProcess: this.handleProcess,
        getPublishedEnvironment: this.getPublishedEnvironment,
      });
    }
    await this.processManager.reconcile(
      trusted ? processDefinitions(definition.tree, definition.projectRootsByNode) : [],
    );
    const configPathsByNode = new Map<string, string>();
    const collectConfigPaths = (node: ResolvedComponentNode): void => {
      configPathsByNode.set(node.id, node.sourceConfigPath ?? definition.location.configPath);
      visitResolvedChildren(node, collectConfigPaths);
    };
    collectConfigPaths(definition.tree);
    this.capabilities.configure({
      projectRoot: definition.location.projectRoot,
      trusted,
      permissionsByNode: definition.permissionsByNode,
      projectRootsByNode: definition.projectRootsByNode,
      configPathsByNode,
      configDirectoriesByNode: new Map([...configPathsByNode].map(([id, path]) => [id, dirname(path)])),
      getPublishedEnvironment: this.getPublishedEnvironment,
    });
    this.snapshot = {
      projectRoot: definition.location.projectRoot,
      configPath: definition.location.configPath,
      dashboardName: definition.config.name,
      iconDataUrl: await this.resolveProjectIcon(definition, trusted),
      config: definition.config,
      configRevision: definition.configRevision,
      componentCatalog: definition.componentCatalog,
        themeCatalog: definition.themeCatalog,
      trusted,
      requestedPermissions: definition.permissions,
      tree: definition.tree,
      components: trusted ? compiledComponents : [],
      processes: this.processManager.list(),
      diagnostics: definition.diagnostics,
      revision: this.snapshot.revision + 1,
    };
    this.snapshot.environmentByNode = await this.readEnvironmentSnapshots();
    return this.emitSnapshot();
  }

  private async readEnvironmentSnapshots(): Promise<Record<string, ComponentEnvironmentSnapshot>> {
    if (!this.snapshot.trusted || !this.snapshot.tree) return {};
    const result: Record<string, ComponentEnvironmentSnapshot> = {};
    const bundles = new Map<string, Promise<Record<string, string>>>();
    const published = this.getPublishedEnvironment();
    const visit = async (node: ResolvedComponentNode): Promise<void> => {
      const path = node.sourceConfigPath ?? this.snapshot.configPath ?? undefined;
      const resource = node.manifest?.resources?.process;
      const explicit = resource?.envProp ? node.props[resource.envProp] as Record<string, string> | undefined : undefined;
      try {
        if (path && !bundles.has(path)) bundles.set(path, readBundleEnvironment(path));
        result[node.id] = environmentSnapshot(path ? await bundles.get(path)! : {}, published, explicit);
      } catch (error) {
        result[node.id] = { ...environmentSnapshot({}, published, explicit), error: errorMessage(error) };
      }
      const pending: Promise<void>[] = [];
      visitResolvedChildren(node, (child) => { pending.push(visit(child)); });
      await Promise.all(pending);
    };
    await visit(this.snapshot.tree);
    return result;
  }

  /** Refresh public environment state without reconciling or interrupting running commands. */
  async refreshEnvironment(): Promise<ProjectSnapshot> {
    return this.enqueue(async () => {
      this.snapshot = {
        ...this.snapshot,
        environmentByNode: await this.readEnvironmentSnapshots(),
        revision: this.snapshot.revision + 1,
      };
      return this.emitSnapshot();
    });
  }

  /** Main-process launch support; deliberately absent from renderer RPC. */
  async getLaunchEnvironment(configPath?: string, explicit: Record<string, string> = {}): Promise<Record<string, string>> {
    if (!this.snapshot.trusted) throw new CoreError("PROJECT_UNTRUSTED", "Trust this project before starting a command.");
    const location = await this.sourceLocation(configPath);
    return resolveEnvironment(location.configPath, this.getPublishedEnvironment(), explicit);
  }

  /** Resolve an optional config-file icon without making it part of the component tree. */
  private async resolveProjectIcon(
    definition: ProjectDefinition,
    trusted: boolean,
  ): Promise<string | null> {
    const source = definition.config?.icon?.trim();
    if (!trusted || !source) return null;
    try {
      const payload = await this.capabilities.readImageWithLimits(
        {
          nodeId: "dash-bored-chrome",
          source,
          timeoutMs: 5_000,
        },
        {
          projectRoot: definition.location.projectRoot,
          trusted: true,
          permissionsByNode: new Map(),
          configDirectoriesByNode: new Map([
            ["dash-bored-chrome", definition.location.configDirectory],
          ]),
        },
      );
      return payload.dataUrl;
    } catch {
      // Sidebar artwork is best-effort; a broken icon must not hide the dashboard.
      return null;
    }
  }

  async load(input: string, options: LoadProjectOptions = {}): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      const nextLocation = (await ensureProjectFiles(input, options)).location;
      const locationChanged = this.location?.projectRoot !== nextLocation.projectRoot
        || this.location?.configPath !== nextLocation.configPath;
      if (locationChanged) {
        this.sessionToken += 1;
        this.stopWatching();
        await this.processManager?.close();
        this.processManager = null;
        this.capabilities.configure(null);
        this.snapshot = {
          ...emptySnapshot(),
          revision: this.snapshot.revision + 1,
        };
      }
      this.location = nextLocation;
      return this.applyDefinition(await loadProjectDefinition(nextLocation));
    });
  }

  async reload(): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
      return this.applyDefinition(await loadProjectDefinition(this.location));
    });
  }

  /** Stop all project-owned activity without closing the reusable runtime. */
  async unload(): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      this.sessionToken += 1;
      this.stopWatching();
      await this.processManager?.close();
      this.processManager = null;
      this.capabilities.configure(null);
      this.location = null;
      this.snapshot = {
        ...emptySnapshot(),
        revision: this.snapshot.revision + 1,
      };
      return this.emitSnapshot();
    });
  }

  private async sourceLocation(configPath?: string): Promise<ProjectLocation> {
    if (configPath === undefined) {
      if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
      return this.location;
    }
    if (this.location !== null && configPath === this.location.configPath) return this.location;
    const requested = await realpath(configPath);
    if (await this.isConfigRegistered?.(requested)) return resolveProjectLocation(requested);
    if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    const reachable = new Set<string>();
    const visit = (node: ResolvedComponentNode): void => {
      if (node.sourceConfigPath) reachable.add(node.sourceConfigPath);
      visitResolvedChildren(node, visit);
    };
    if (this.snapshot.tree) visit(this.snapshot.tree);
    if (!reachable.has(requested)) {
      throw new CoreError(
        "DASHBOARD_CONFIG_NOT_REACHABLE",
        "Only the active config or a config linked from its rendered tree may be edited.",
      );
    }
    return resolveProjectLocation(requested);
  }

  async getDashboardConfigSource(configPath?: string): Promise<DashboardConfigSource> {
    return this.enqueue(async () => {
      const location = await this.sourceLocation(configPath);
      const definition = await loadProjectDefinition(location);
      if (!definition.config || !definition.configRevision) {
        throw new CoreError(
          "DASHBOARD_CONFIG_INVALID",
          definition.diagnostics[0]?.message ?? "The dashboard config could not be loaded.",
        );
      }
      return {
        configPath: location.configPath,
        config: structuredClone(definition.config),
        configRevision: definition.configRevision,
        componentCatalog: structuredClone(definition.componentCatalog),
      };
    });
  }

  async validateDashboardDraft(
    config: DashboardConfig,
    configPath?: string,
  ): Promise<DashboardDraftValidation> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      const location = await this.sourceLocation(configPath);
      const definition = await validateProjectConfigDraft(location, structuredClone(config));
      return {
        ok: definition.ok,
        diagnostics: definition.diagnostics,
        requestedPermissions: definition.permissions,
      };
    });
  }

  async validateComponentProps(
    reference: string,
    props: Record<string, unknown>,
  ): Promise<ComponentPropsValidation> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
      const item = this.snapshot.componentCatalog.find((candidate) => candidate.reference === reference);
      if (!item?.available || !item.manifest) {
        return {
          ok: false,
          diagnostics: [diagnostic({ code: "COMPONENT_UNAVAILABLE", message: "That component is not available.", path: reference })],
        };
      }
      const errors = validatePropsSchema(item.manifest.propsSchema, structuredClone(props));
      return {
        ok: errors.length === 0,
        diagnostics: errors.map((error) => diagnostic({
          code: "COMPONENT_PROPS_INVALID",
          message: error.message ?? "Invalid component props.",
          path: `props${error.instancePath.replaceAll("/", ".")}`,
        })),
      };
    });
  }

  async saveDashboardConfig(
    config: DashboardConfig,
    expectedConfigRevision: string,
    configPath?: string,
  ): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      const activeLocation = this.location;
      const location = await this.sourceLocation(configPath);
      const currentRevision = await readConfigRevision(location.configPath);
      if (currentRevision !== expectedConfigRevision) {
        throw new CoreError(
          "DASHBOARD_CONFIG_CONFLICT",
          "dash-bored.yaml changed after editing started. Cancel this draft and reopen edit mode before saving.",
        );
      }

      const definition = await validateProjectConfigDraft(
        location,
        structuredClone(config),
      );
      if (!definition.ok || definition.tree === null || definition.config === null) {
        const detail = definition.diagnostics[0]?.message ?? "The dashboard draft is invalid.";
        throw new CoreError("DASHBOARD_DRAFT_INVALID", detail);
      }

      let precompiled: CompiledLocalComponent[] | undefined;
      const trusted =
        activeLocation !== null &&
        !this.sessionRevokedRoots.has(activeLocation.projectRoot) &&
        (await this.trustStore.isTrusted(activeLocation.projectRoot, definition.permissions));
      if (trusted) {
        const compiled = await compileLocalComponents(definition.localComponents);
        if (hasErrors(compiled.diagnostics)) {
          throw new CoreError(
            "DASHBOARD_COMPONENT_COMPILE_FAILED",
            compiled.diagnostics[0]?.message ?? "A local component could not be compiled.",
          );
        }
        precompiled = compiled.components;
      }

      await replaceDashboardConfigAtomic(location, definition.config);
      if (activeLocation === null) return this.getSnapshot();
      if (location.configPath === activeLocation.configPath) {
        definition.configRevision = await readConfigRevision(location.configPath);
        return this.applyDefinition(definition, precompiled);
      }
      return this.applyDefinition(await loadProjectDefinition(activeLocation));
    });
  }

  async trust(): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      if (this.location === null || this.snapshot.tree === null) {
        throw new CoreError("PROJECT_NOT_LOADED", "Load a valid project before trusting it.");
      }
      await this.trustStore.trust(this.location.projectRoot, this.snapshot.requestedPermissions);
      this.sessionRevokedRoots.delete(this.location.projectRoot);
      return this.applyDefinition(await loadProjectDefinition(this.location));
    });
  }

  async revoke(): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      this.sessionToken += 1;
      if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");

      // Disable privileged calls before waiting for persistence or process cleanup.
      this.capabilities.configure({
        projectRoot: this.location.projectRoot,
        trusted: false,
        permissionsByNode: new Map(),
      });
      this.sessionRevokedRoots.add(this.location.projectRoot);
      this.snapshot = {
        ...this.snapshot,
        trusted: false,
        components: [],
        revision: this.snapshot.revision + 1,
      };
      this.emitSnapshot();

      const revokeDiagnostics = [];
      try {
        await this.trustStore.revoke(this.location.projectRoot);
      } catch (error) {
        revokeDiagnostics.push(
          diagnostic({ code: "TRUST_STORE_WRITE_FAILED", message: errorMessage(error) }),
        );
      }
      await this.processManager?.reconcile([]);
      this.snapshot = {
        ...this.snapshot,
        processes: this.processManager?.list() ?? [],
        diagnostics: [...this.snapshot.diagnostics, ...revokeDiagnostics],
      };
      return this.emitSnapshot();
    });
  }

  getSnapshot(): ProjectSnapshot {
    if (this.processManager !== null) {
      this.snapshot = { ...this.snapshot, processes: this.processManager.list() };
    }
    return cloneSnapshot(this.snapshot);
  }

  async startProcess(nodeId: string): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.start(nodeId);
  }

  async openProcessTerminal(nodeId: string): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.open(nodeId);
  }

  async runProcessQuickAction(nodeId: string): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.runQuickAction(nodeId);
  }

  async writeProcessTerminal(nodeId: string, input: string): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.write(nodeId, input);
  }

  async resizeProcessTerminal(nodeId: string, cols: number, rows: number): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.resize(nodeId, cols, rows);
  }

  async stopProcess(nodeId: string): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.stop(nodeId);
  }

  readText(request: FileReadRequest): Promise<string> {
    return this.capabilities.readText(request);
  }

  async writeText(request: FileWriteRequest): Promise<void> {
    await this.capabilities.writeText(request);
    await this.refreshEnvironment();
  }

  http(request: HttpRequest): Promise<HttpResponsePayload> {
    return this.capabilities.http(request);
  }

  runShell(request: ShellRunRequest): Promise<ShellRunResult> {
    return this.capabilities.runShell(request);
  }

  watch(): void {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    if (this.watcher !== null) return;
    try {
      this.watcher = watchFileSystem(this.location.configDirectory, { recursive: true }, (_eventType, filename) => {
        if (typeof filename === "string" && isGitInternalPath(filename)) return;
        if (this.watchTimer !== null) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.reload().catch((error) => {
            this.snapshot = {
              ...this.snapshot,
              diagnostics: [diagnostic({ code: "PROJECT_RELOAD_FAILED", message: errorMessage(error) })],
              revision: this.snapshot.revision + 1,
            };
            this.emitSnapshot();
          });
        }, this.watchDebounceMs);
      });
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        diagnostics: [diagnostic({ code: "PROJECT_WATCH_FAILED", message: errorMessage(error) })],
        revision: this.snapshot.revision + 1,
      };
      this.emitSnapshot();
      return;
    }
    this.watcher.on("error", (error) => {
      this.snapshot = {
        ...this.snapshot,
        diagnostics: [diagnostic({ code: "PROJECT_WATCH_FAILED", message: errorMessage(error) })],
        revision: this.snapshot.revision + 1,
      };
      this.emitSnapshot();
    });
  }

  private stopWatching(): void {
    if (this.watchTimer !== null) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sessionToken += 1;
    this.stopWatching();
    await this.operation.catch(() => undefined);
    await this.processManager?.close();
    this.processManager = null;
    this.capabilities.configure(null);
  }
}
