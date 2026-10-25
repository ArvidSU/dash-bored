import { CoreError, type ProjectRuntime, loadPromptTemplates, prepareAgentPrompt, promptTemplateSummaries, promptTemplateSummary, resolveProjectLocation, resolvePromptTemplate } from "../core/index";
import { readBundleEnvironment, resolveEnvironment } from "../core/environment";
import type { ProjectLocation } from "../core/paths";
import { KNOWN_AGENTS } from "../shared/agent-catalog";
import { agentSetup } from "../shared/agent-setup";
import type {
  AgentCommandChoice,
  AgentCommandOptions,
  AgentConfigChoices,
  AgentLaunchRequest,
  AgentSessionTask,
  AgentTaskCommand,
  ComponentAgentPreview,
  ComponentAgentRequest,
  ComponentCreationAgentRequest,
  DetectedAgent,
} from "../shared/agent-session";
import { isAgentTaskBusy } from "../shared/agent-session";
import {
  buildComponentCreationAgentPrompt,
  buildDiagnosticsAgentPrompt,
  componentPath,
  findResolvedNode,
  promptComponent,
  resolveDashboardInsertion,
} from "../shared/component-agent";
import type { AgentPromptTemplateSummary, ComponentAgentLaunch, ResolvedComponentNode } from "../shared/contracts";
import { assertAgentAvailable } from "./agent-preflight";
import { agentDisplay, detectAgents, detectPackageRunner } from "./agent-detection";
import type { AgentConfigMemory } from "./agent-config-memory";
import { MAX_CONFIG_OPTIONS, MAX_LABEL_LENGTH } from "./agent-session-updates";
import type { AgentSessions } from "./agent-sessions";
import { AppSettingsStore, normalizeDashBoredAgent } from "./app-settings";
import { DashboardSetupSupervisor } from "./dashboard-setup";

export interface AgentLauncherOptions {
  runtime: ProjectRuntime;
  sessions: AgentSessions;
  settings: Pick<AppSettingsStore, "get">;
  publishedEnvironment(): Record<string, string>;
  /** Config options remembered per launch command, for the composer. */
  configMemory?: Pick<AgentConfigMemory, "get" | "chose">;
  /** Known agents on the app's PATH; injectable for tests. */
  detect?: () => DetectedAgent[];
  packageRunner?: () => "npx" | "bunx" | null;
}

/** A resolved launch command and how it was chosen. */
export interface ResolvedAgentCommand {
  source: "app" | "project" | "detected" | "custom";
  command: string;
  name: string;
}

/** The composer's config choices, checked for shape; the session checks them against what the agent offers. */
function launchConfig(value: unknown): AgentConfigChoices | undefined {
  if (value === undefined) return undefined;
  const entries = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : null;
  if (entries === null || entries.length > MAX_CONFIG_OPTIONS || entries.some(([id, choice]) => id === "" || id.length > MAX_LABEL_LENGTH
    || !(typeof choice === "boolean" || (typeof choice === "string" && choice.length <= MAX_LABEL_LENGTH)))) {
    throw new CoreError("COMPONENT_AGENT_CONFIG_INVALID", "The agent options could not be read. Reopen the composer and choose them again.");
  }
  return Object.fromEntries(entries) as AgentConfigChoices;
}

function unavailable(): CoreError {
  const examples = KNOWN_AGENTS.slice(0, 3).map((agent) => `${agent.name} (${agent.command})`).join(", ");
  return new CoreError(
    "AGENT_UNAVAILABLE",
    `No ACP agent is configured or enabled. Enable one, such as ${examples}, or choose a command in Settings → General → Dashboard agent.`,
  );
}

/** Every agent the app starts: component, creation, diagnostics, and setup work. */
export class AgentLauncher {
  constructor(private readonly options: AgentLauncherOptions) {}

  private async configured() {
    const settings = await this.options.settings.get();
    const installed = this.options.detect?.() ?? detectAgents();
    const runner = this.options.packageRunner ? this.options.packageRunner() : detectPackageRunner();
    return agentSetup(KNOWN_AGENTS, installed, settings.enabledAgentIds, runner);
  }

  /**
   * The effective agent for work on `configPath`: the app setting, else the
   * owning bundle's `.env`, else the first enabled agent. `bundleless`
   * skips the project-controlled bundle `.env` so an untrusted repair cannot
   * select its own agent command.
   */
  async resolve(configPath: string | undefined, choice?: AgentCommandChoice, options: { bundleless?: boolean } = {}): Promise<ResolvedAgentCommand> {
    const named = (source: ResolvedAgentCommand["source"], command: string): ResolvedAgentCommand =>
      ({ source, command, name: agentDisplay(command).name });
    if (choice?.source === "custom") return named("custom", normalizeDashBoredAgent(choice.command));
    if (choice?.source === "detected") {
      // Re-resolved from the catalog: a renderer never supplies this command.
      const known = (await this.configured()).detected.find((agent) => agent.id === choice.id);
      if (!known) throw new CoreError("AGENT_UNAVAILABLE", "That agent is disabled or needs setup in Settings → General → Dashboard agent.");
      return { source: "detected", command: known.command, name: known.name };
    }
    const app = (await this.options.settings.get()).dashBoredAgent;
    if (choice?.source === "app") {
      if (app === null) throw new CoreError("AGENT_COMMAND_UNAVAILABLE", "No app-wide agent is set in Settings → General → Dashboard agent.");
      return named("app", app);
    }
    const project = configPath && options.bundleless !== true ? await this.projectCommand(configPath) : null;
    if (choice?.source === "project") {
      if (project === null) throw new CoreError("AGENT_COMMAND_UNAVAILABLE", "This dashboard's .env does not set DASH_BORED_AGENT.");
      return named("project", project);
    }
    if (app !== null) return named("app", app);
    if (project !== null) return named("project", project);
    const [first] = (await this.configured()).detected;
    if (first) return { source: "detected", command: first.command, name: first.name };
    throw unavailable();
  }

  /** The effective command for work on `configPath`, as a migration agent uses it. */
  async command(configPath: string, options: { bundleless?: boolean } = {}): Promise<string> {
    return (await this.resolve(configPath, undefined, options)).command;
  }

  private async projectCommand(configPath: string): Promise<string | null> {
    return (await readBundleEnvironment(configPath)).DASH_BORED_AGENT?.trim() || null;
  }

  /** The agents Settings (no `configPath`) or one bundle's composer can pick from. */
  async agentOptions(configPath?: string): Promise<AgentCommandOptions> {
    const app = (await this.options.settings.get()).dashBoredAgent;
    const project = configPath ? await this.projectCommand(configPath) : null;
    const { detected, setup } = await this.configured();
    const effective = app !== null
      ? { source: "app" as const, command: app, name: agentDisplay(app).name }
      : project !== null
        ? { source: "project" as const, command: project, name: agentDisplay(project).name }
        : detected[0]
          ? { source: "detected" as const, command: detected[0].command, name: detected[0].name }
          : null;
    const config = await this.options.configMemory?.get();
    return { app, project, detected, setup, known: KNOWN_AGENTS.map((agent) => ({ ...agent })), effective, ...(config ? { config } : {}) };
  }

  launch(request: AgentLaunchRequest): Promise<ComponentAgentLaunch> {
    switch (request.kind) {
      case "component": return this.launchComponent(request);
      case "creation": return this.launchCreation(request);
      case "diagnostics": return this.launchDiagnostics();
    }
  }

  async preview(request: ComponentAgentRequest): Promise<ComponentAgentPreview> {
    const { template, prompt, templates, source } = await this.prepareComponent(request, true);
    return {
      template: promptTemplateSummary(template),
      prompt,
      templates: promptTemplateSummaries(templates.templates),
      agents: await this.agentOptions(source.configPath),
    };
  }

  /** Catalog for the focused target's owning bundle; discovery reads no launch environment. */
  async promptTemplates(nodeId: string): Promise<AgentPromptTemplateSummary[]> {
    const { runtime } = this.options;
    const tree = runtime.getSnapshot().tree;
    const node = tree ? findResolvedNode(tree, nodeId) : null;
    if (!node) throw new CoreError("COMPONENT_NOT_FOUND", "The prompt target is no longer present. Choose a component again.");
    const source = await runtime.getDashboardConfigSource(node.sourceConfigPath);
    const location = await resolveProjectLocation(source.configPath);
    return promptTemplateSummaries((await loadPromptTemplates(location.configDirectory)).templates);
  }

  taskCommand(taskId: string, command: AgentTaskCommand): Promise<AgentSessionTask> {
    return this.options.sessions.command(taskId, command);
  }

  private supervisor(command: string, location: ProjectLocation): DashboardSetupSupervisor {
    const { runtime, sessions } = this.options;
    return new DashboardSetupSupervisor({ runtime, harness: sessions, command, location, preflight: assertAgentAvailable });
  }

  private async prepareComponent(request: ComponentAgentRequest, preview = false) {
    const { runtime } = this.options;
    const snapshot = runtime.getSnapshot();
    if (!snapshot.tree || !snapshot.projectRoot) {
      throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before asking an agent to work from it.");
    }
    const tree = snapshot.tree;
    const nodeIds = [...new Set(request.nodeIds)];
    if (nodeIds.length === 0) {
      throw new CoreError("COMPONENT_NOT_FOUND", "Choose a component for the agent to work from.");
    }
    const nodes = nodeIds.map((nodeId) => findResolvedNode(tree, nodeId));
    if (nodes.some((node) => node === null)) {
      throw new CoreError(
        "COMPONENT_NOT_FOUND",
        nodes.length > 1
          ? "A selected component is no longer present. Pick the components again."
          : "That component is no longer present. Reopen its menu and try again.",
      );
    }
    const targets = nodes as ResolvedComponentNode[];
    const [node] = targets as [ResolvedComponentNode, ...ResolvedComponentNode[]];
    const source = await runtime.getDashboardConfigSource(node.sourceConfigPath);
    // Templates, environment, and validation belong to one bundle.
    for (const other of targets.slice(1)) {
      if ((await runtime.getDashboardConfigSource(other.sourceConfigPath)).configPath !== source.configPath) {
        throw new CoreError(
          "COMPONENT_AGENT_TARGETS_MIXED",
          "The selected components belong to different dashboards. Pick components from one dashboard.",
        );
      }
    }
    const sourceLocation = await resolveProjectLocation(source.configPath);
    const locator = componentPath(node);
    // Templates are re-read from the owning bundle so the renderer only names one.
    const templates = await loadPromptTemplates(sourceLocation.configDirectory);
    const declaresEnv = resolvePromptTemplate(templates.templates, request.template)?.env.length ?? 0;
    const env = declaresEnv > 0 ? await runtime.getLaunchEnvironment(source.configPath) : {};
    try {
      const prepared = prepareAgentPrompt(templates, {
        template: request.template,
        input: request.prompt,
        vars: request.vars,
        env,
        allowEmptyInput: preview,
        projectRoot: sourceLocation.projectRoot,
        configPath: source.configPath,
        configDirectory: sourceLocation.configDirectory,
        components: targets.map(promptComponent),
      });
      return { ...prepared, templates, source, sourceLocation, locator };
    } catch (error) {
      throw new CoreError("COMPONENT_AGENT_PROMPT_INVALID", error instanceof Error ? error.message : String(error));
    }
  }

  private async launchComponent(request: ComponentAgentRequest): Promise<ComponentAgentLaunch> {
    const config = launchConfig(request.config);
    const { template, prompt, source, sourceLocation, locator } = await this.prepareComponent(request);
    const { command } = await this.resolve(source.configPath, request.agent);
    const dashboardWork = template.scope === "dashboard";
    // Two agents editing one dashboard race on its YAML; components cannot see each other's launches.
    if (dashboardWork && this.options.sessions.list().some((task) => task.configPath === source.configPath
      && task.purpose !== undefined && task.purpose !== "project" && isAgentTaskBusy(task))) {
      throw new CoreError("DASHBOARD_AGENT_RUNNING", "Agent work is already changing this dashboard. Open Agent work to view or stop it.");
    }
    const launched = await this.supervisor(command, sourceLocation).launchRequest({
      prompt,
      // Only dashboard work is validated when a turn ends and may receive the
      // single automatic repair; project work is the user's to review.
      purpose: dashboardWork ? "edit" : "project",
      followUp: dashboardWork,
      template: template.name,
      componentPath: locator,
      configPath: source.configPath,
      request: request.prompt.trim() || template.description,
      ...(config && Object.keys(config).length > 0 ? { config } : {}),
    });
    // The composer offers these choices again next time; an empty set returns every option to its default.
    if (config) await this.options.configMemory?.chose(command, config);
    return launched;
  }

  private async launchCreation({ configPath, target, prompt: userPrompt }: ComponentCreationAgentRequest): Promise<ComponentAgentLaunch> {
    const source = await this.options.runtime.getDashboardConfigSource(configPath);
    const sourceLocation = await resolveProjectLocation(source.configPath);
    const insertion = resolveDashboardInsertion(source, target);
    if (!insertion) {
      throw new CoreError(
        "COMPONENT_INSERTION_TARGET_INVALID",
        "That component insertion point is no longer present. Reopen the dashboard editor and try again.",
      );
    }
    const command = await this.command(source.configPath);
    const prompt = buildComponentCreationAgentPrompt({
      projectRoot: sourceLocation.projectRoot,
      configPath: source.configPath,
      insertion,
    }, userPrompt);
    return this.supervisor(command, sourceLocation).launchRequest({
      prompt,
      purpose: "edit",
      componentPath: `${source.configPath}#${insertion.path}`,
      configPath: source.configPath,
      request: userPrompt,
    });
  }

  private async launchDiagnostics(): Promise<ComponentAgentLaunch> {
    const snapshot = this.options.runtime.getSnapshot();
    if (!snapshot.projectRoot || !snapshot.configPath) {
      throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before asking an agent to fix its diagnostics.");
    }
    if (snapshot.diagnostics.length === 0) {
      throw new CoreError("DIAGNOSTICS_NOT_FOUND", "This dashboard has no current diagnostics to fix.");
    }
    // A project that cannot be trusted yet must still be repairable. The
    // untrusted repair runs the app-selected agent with no project-controlled
    // input: no bundle `.env`, no project instructions in the prompt, no
    // capability grant, and out-of-bundle edits refused. Reads and commands
    // can receive one-time user approval to unblock repair. The
    // project stays untrusted until the ordinary review.
    const untrustedRepair = !snapshot.trusted;
    const sourceLocation = await resolveProjectLocation(snapshot.configPath);
    const prompt = buildDiagnosticsAgentPrompt({
      projectRoot: sourceLocation.projectRoot,
      configPath: snapshot.configPath,
      diagnostics: snapshot.diagnostics,
      untrustedRepair,
    });

    const command = await this.command(snapshot.configPath, { bundleless: untrustedRepair });
    return this.supervisor(command, sourceLocation).launchRequest({
      prompt,
      purpose: "edit",
      componentPath: `${snapshot.configPath}#diagnostics`,
      configPath: snapshot.configPath,
      request: "Fix dashboard configuration diagnostics.",
      untrustedRepair,
      env: untrustedRepair
        ? await resolveEnvironment(undefined, this.options.publishedEnvironment())
        : undefined,
    });
  }

}
