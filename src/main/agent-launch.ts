import { CoreError, type ProjectRuntime, loadPromptTemplates, prepareAgentPrompt, promptTemplateSummaries, promptTemplateSummary, resolveProjectLocation, resolvePromptTemplate } from "../core/index";
import { readBundleEnvironment, resolveEnvironment } from "../core/environment";
import type { ProjectLocation } from "../core/paths";
import { KNOWN_AGENTS } from "../shared/agent-catalog";
import type {
  AgentCommandChoice,
  AgentCommandOptions,
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
  resolveDashboardInsertion,
} from "../shared/component-agent";
import type { ComponentAgentLaunch } from "../shared/contracts";
import { assertAgentAvailable } from "./agent-preflight";
import { agentDisplay, detectAgents } from "./agent-detection";
import type { AgentSessions } from "./agent-sessions";
import { AppSettingsStore, normalizeDashBoredAgent } from "./app-settings";
import { DashboardSetupSupervisor, findSetupNode } from "./dashboard-setup";

export interface AgentLauncherOptions {
  runtime: ProjectRuntime;
  sessions: AgentSessions;
  settings: Pick<AppSettingsStore, "get">;
  publishedEnvironment(): Record<string, string>;
  /** Known agents on the app's PATH; injectable for tests. */
  detect?: () => DetectedAgent[];
}

/** A resolved launch command and how it was chosen. */
export interface ResolvedAgentCommand {
  source: "app" | "project" | "detected" | "custom";
  command: string;
  name: string;
}

function unavailable(): CoreError {
  const examples = KNOWN_AGENTS.slice(0, 3).map((agent) => `${agent.name} (${agent.command})`).join(", ");
  return new CoreError(
    "AGENT_UNAVAILABLE",
    `No ACP agent is configured or detected on PATH. Install one, such as ${examples}, or choose a command in Settings → General → Dashboard agent.`,
  );
}

/** Every agent the app starts: component, creation, diagnostics, and setup work. */
export class AgentLauncher {
  constructor(private readonly options: AgentLauncherOptions) {}

  private detected(): DetectedAgent[] {
    return this.options.detect?.() ?? detectAgents();
  }

  /**
   * The effective agent for work on `configPath`: the app setting, else the
   * owning bundle's `.env`, else the first detected agent. `bundleless`
   * skips the project-controlled bundle `.env` so an untrusted repair cannot
   * select its own agent command.
   */
  async resolve(configPath: string | undefined, choice?: AgentCommandChoice, options: { bundleless?: boolean } = {}): Promise<ResolvedAgentCommand> {
    const named = (source: ResolvedAgentCommand["source"], command: string): ResolvedAgentCommand =>
      ({ source, command, name: agentDisplay(command).name });
    if (choice?.source === "custom") return named("custom", normalizeDashBoredAgent(choice.command));
    if (choice?.source === "detected") {
      // Re-resolved from the catalog: a renderer never supplies this command.
      const known = KNOWN_AGENTS.find((agent) => agent.id === choice.id);
      if (!known) throw new CoreError("AGENT_UNAVAILABLE", "That agent is not in the known-agent list.");
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
    const [first] = this.detected();
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
    const detected = this.detected();
    const effective = app !== null
      ? { source: "app" as const, command: app, name: agentDisplay(app).name }
      : project !== null
        ? { source: "project" as const, command: project, name: agentDisplay(project).name }
        : detected[0]
          ? { source: "detected" as const, command: detected[0].command, name: detected[0].name }
          : null;
    return { app, project, detected, known: KNOWN_AGENTS.map((agent) => ({ ...agent })), effective };
  }

  launch(request: AgentLaunchRequest): Promise<ComponentAgentLaunch> {
    switch (request.kind) {
      case "component": return this.launchComponent(request);
      case "creation": return this.launchCreation(request);
      case "diagnostics": return this.launchDiagnostics();
      case "setup": return this.launchSetup(request.nodeId);
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
    const node = findResolvedNode(snapshot.tree, request.nodeId);
    if (!node) {
      throw new CoreError(
        "COMPONENT_NOT_FOUND",
        "That component is no longer present. Reopen its menu and try again.",
      );
    }
    const source = await runtime.getDashboardConfigSource(node.sourceConfigPath);
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
        component: {
          id: node.id,
          reference: node.component,
          path: locator,
          name: node.configName?.trim() || node.manifest?.name || node.component,
        },
      });
      return { ...prepared, templates, source, sourceLocation, locator };
    } catch (error) {
      throw new CoreError("COMPONENT_AGENT_PROMPT_INVALID", error instanceof Error ? error.message : String(error));
    }
  }

  private async launchComponent(request: ComponentAgentRequest): Promise<ComponentAgentLaunch> {
    const { template, prompt, source, sourceLocation, locator } = await this.prepareComponent(request);
    const { command } = await this.resolve(source.configPath, request.agent);
    const dashboardWork = template.scope === "dashboard";
    return this.supervisor(command, sourceLocation).launchRequest({
      prompt,
      // Only dashboard work is validated when a turn ends and may receive the
      // single automatic repair; project work is the user's to review.
      purpose: dashboardWork ? "edit" : "project",
      followUp: dashboardWork,
      template: template.name,
      componentPath: locator,
      configPath: source.configPath,
      request: request.prompt.trim() || template.description,
    });
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
    // capability grant, and out-of-bundle permission requests refused. The
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

  private async launchSetup(nodeId: string): Promise<ComponentAgentLaunch> {
    const { runtime, sessions } = this.options;
    const snapshot = runtime.getSnapshot();
    const session = runtime.getSessionToken();
    if (!snapshot.projectRoot || !snapshot.configPath || !snapshot.tree) {
      throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before running its setup agent.");
    }
    if (!snapshot.trusted) {
      throw new CoreError("PROJECT_UNTRUSTED", "Trust this project before running its setup agent.");
    }
    const node = findSetupNode(runtime, nodeId);
    if (!node) {
      throw new CoreError("DASHBOARD_SETUP_NODE_INVALID", "That setup action is no longer present in the active dashboard.");
    }
    const configPath = node.sourceConfigPath ?? snapshot.configPath;
    if (sessions.list().some((task) => task.configPath === configPath
      && task.purpose !== undefined && isAgentTaskBusy(task))) {
      throw new CoreError("DASHBOARD_SETUP_RUNNING", "Agent work is already active for this dashboard. Open Agent work to view or stop it.");
    }
    const sourceLocation = await resolveProjectLocation(configPath);
    const command = await this.command(configPath);
    if (runtime.getSessionToken() !== session) throw new CoreError("DASHBOARD_SETUP_STALE", "The active dashboard changed. Run setup from its current panel.");
    return this.supervisor(command, sourceLocation).launch(node);
  }
}
