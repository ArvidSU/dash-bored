import { watch as watchFileSystem, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import type {
  CompiledLocalComponent,
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

const DEFAULT_WATCH_DEBOUNCE_MS = 120;

export interface ProjectRuntimeOptions {
  trustStore: TrustStore;
  onSnapshot?: (snapshot: ProjectSnapshot) => void;
  onProcess?: (snapshot: ProcessSnapshot) => void;
  watchDebounceMs?: number;
}

export interface LoadProjectOptions {
  inputKind?: "auto" | "project-root";
}

function emptySnapshot(): ProjectSnapshot {
  return {
    projectRoot: null,
    dashboardName: null,
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
    if (node.component === "@dash-bored/command") {
      definitions.push({
        id: node.id,
        command: String(node.props.command),
        ...(projectRootsByNode.get(node.id) === undefined
          ? {}
          : { projectRoot: projectRootsByNode.get(node.id) }),
        ...(typeof node.props.cwd === "string" ? { cwd: node.props.cwd } : {}),
        ...(node.props.env !== undefined
          ? { env: node.props.env as Record<string, string> }
          : {}),
      });
    }
    for (const children of Object.values(node.slots)) {
      for (const child of children) visit(child);
    }
  };
  visit(tree);
  return definitions;
}

function cloneSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  return structuredClone(snapshot);
}

export class ProjectRuntime {
  private readonly trustStore: TrustStore;
  private readonly onSnapshot?: (snapshot: ProjectSnapshot) => void;
  private readonly onProcess?: (snapshot: ProcessSnapshot) => void;
  private readonly watchDebounceMs: number;
  private readonly capabilities = new CapabilityService();
  private snapshot: ProjectSnapshot = emptySnapshot();
  private location: ProjectLocation | null = null;
  private processManager: ProcessManager | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly sessionRevokedRoots = new Set<string>();
  private closed = false;

  constructor(options: ProjectRuntimeOptions) {
    this.trustStore = options.trustStore;
    this.onSnapshot = options.onSnapshot;
    this.onProcess = options.onProcess;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
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
        dashboardName: this.snapshot.tree === null ? definition.config?.name ?? null : this.snapshot.dashboardName,
        config: definition.config ?? this.snapshot.config,
        configRevision: definition.configRevision,
        componentCatalog: definition.componentCatalog,
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
            configRevision: definition.configRevision,
            componentCatalog: definition.componentCatalog,
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
      });
    }
    await this.processManager.reconcile(
      trusted ? processDefinitions(definition.tree, definition.projectRootsByNode) : [],
    );
    this.capabilities.configure({
      projectRoot: definition.location.projectRoot,
      trusted,
      permissionsByNode: definition.permissionsByNode,
      projectRootsByNode: definition.projectRootsByNode,
    });
    this.snapshot = {
      projectRoot: definition.location.projectRoot,
      dashboardName: definition.config.name,
      config: definition.config,
      configRevision: definition.configRevision,
      componentCatalog: definition.componentCatalog,
      trusted,
      requestedPermissions: definition.permissions,
      tree: definition.tree,
      components: trusted ? compiledComponents : [],
      processes: this.processManager.list(),
      diagnostics: definition.diagnostics,
      revision: this.snapshot.revision + 1,
    };
    return this.emitSnapshot();
  }

  async load(input: string, options: LoadProjectOptions = {}): Promise<ProjectSnapshot> {
    if (this.closed) throw new CoreError("PROJECT_RUNTIME_CLOSED", "The project runtime is closed.");
    return this.enqueue(async () => {
      const nextLocation = (await ensureProjectFiles(input, options)).location;
      if (this.location?.projectRoot !== nextLocation.projectRoot) {
        this.stopWatching();
        await this.processManager?.close();
        this.processManager = null;
        this.capabilities.configure(null);
        this.snapshot = emptySnapshot();
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
    if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    if (configPath === undefined || configPath === this.location.configPath) return this.location;
    const requested = await realpath(configPath);
    const reachable = new Set<string>();
    const visit = (node: ResolvedComponentNode): void => {
      if (node.sourceConfigPath) reachable.add(node.sourceConfigPath);
      for (const children of Object.values(node.slots)) for (const child of children) visit(child);
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
      if (this.location === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
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
        !this.sessionRevokedRoots.has(this.location.projectRoot) &&
        (await this.trustStore.isTrusted(this.location.projectRoot, definition.permissions));
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
      if (location.configPath === this.location.configPath) {
        definition.configRevision = await readConfigRevision(location.configPath);
        return this.applyDefinition(definition, precompiled);
      }
      return this.applyDefinition(await loadProjectDefinition(this.location));
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

  async stopProcess(nodeId: string): Promise<ProcessSnapshot> {
    this.capabilities.assertAllowed(nodeId, "process:execute");
    if (this.processManager === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    return this.processManager.stop(nodeId);
  }

  readText(request: FileReadRequest): Promise<string> {
    return this.capabilities.readText(request);
  }

  writeText(request: FileWriteRequest): Promise<void> {
    return this.capabilities.writeText(request);
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
      this.watcher = watchFileSystem(this.location.configDirectory, { recursive: true }, () => {
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
    this.stopWatching();
    await this.operation.catch(() => undefined);
    await this.processManager?.close();
    this.processManager = null;
    this.capabilities.configure(null);
  }
}
