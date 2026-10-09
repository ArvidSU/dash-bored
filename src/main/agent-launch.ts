import { CoreError, type ProjectRuntime, loadPromptTemplates, prepareAgentPrompt, promptTemplateSummaries, promptTemplateSummary, resolveProjectLocation, resolvePromptTemplate } from "../core/index";
import { readBundleEnvironment, resolveEnvironment } from "../core/environment";
import type { ProjectLocation } from "../core/paths";
import {
  buildComponentCreationAgentPrompt,
  buildDiagnosticsAgentPrompt,
  componentPath,
  findResolvedNode,
  resolveDashboardInsertion,
} from "../shared/component-agent";
import { DEFAULT_DASH_BORED_AGENT } from "../shared/app-settings";
import type {
  AgentCommandChoice,
  AgentCommandOptions,
  AgentLaunchRequest,
  AgentTaskCommand,
  ComponentAgentLaunch,
  ComponentAgentPreview,
  ComponentAgentRequest,
  ComponentCreationAgentRequest,
  DashboardAgentTask,
} from "../shared/contracts";
import { isProcessRunActive } from "../shared/process-state";
import { assertAgentAvailable } from "./agent-preflight";
import { AppSettingsStore, normalizeDashBoredAgent, resolveDashBoredAgent } from "./app-settings";
import type { DashboardAgentHarness } from "./component-agent";
import { readDashboardAgentDiff } from "./dashboard-agent-diff";
import { DashboardSetupSupervisor, findSetupNode } from "./dashboard-setup";

export interface AgentLauncherOptions {
  runtime: ProjectRuntime;
  harness: DashboardAgentHarness;
  settings: AppSettingsStore;
  publishedEnvironment(): Record<string, string>;
}

/** Every agent the app starts: component, creation, diagnostics, and setup work. */
export class AgentLauncher {
  constructor(private readonly options: AgentLauncherOptions) {}

  /**
   * The configured agent command for work on `configPath`. `bundleless`
   * excludes project-controlled bundle `.env` values so an untrusted repair
   * cannot select or configure its own agent command.
   */
  async command(configPath: string, options: { bundleless?: boolean } = {}): Promise<string> {
    const settings = await this.options.settings.get();
    if (settings.dashBoredAgent !== null) return settings.dashBoredAgent;
    const environment = await resolveEnvironment(
      options.bundleless === true ? undefined : configPath,
      this.options.publishedEnvironment(),
    );
    return resolveDashBoredAgent(settings.dashBoredAgent, environment);
  }

  /** The commands the composer offers for work on `configPath`, and which one applies by default. */
  async commandOptions(configPath: string): Promise<AgentCommandOptions> {
    const settings = await this.options.settings.get();
    const project = (await readBundleEnvironment(configPath)).DASH_BORED_AGENT?.trim() || null;
    return {
      app: settings.dashBoredAgent ?? DEFAULT_DASH_BORED_AGENT,
      project,
      effective: settings.dashBoredAgent === null && project !== null ? "project" : "app",
    };
  }

  /** The command one composer launch runs; an explicit choice is the user's reviewed pick. */
  private async chosenCommand(configPath: string, choice: AgentCommandChoice | undefined): Promise<string> {
    if (choice === undefined) return this.command(configPath);
    if (choice.source === "custom") return normalizeDashBoredAgent(choice.command);
    const options = await this.commandOptions(configPath);
    if (choice.source === "app") return options.app;
    if (options.project === null) {
      throw new CoreError("AGENT_COMMAND_UNAVAILABLE", "This dashboard's .env does not set DASH_BORED_AGENT.");
    }
    return options.project;
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
      agents: await this.commandOptions(source.configPath),
    };
  }

  taskCommand(taskId: string, command: AgentTaskCommand): Promise<DashboardAgentTask> {
    const { harness } = this.options;
    switch (command.type) {
      case "stop": return harness.stop(taskId);
      case "write": return harness.writeTerminal(taskId, command.input);
      case "resize": return harness.resizeTerminal(taskId, command.cols, command.rows);
    }
  }

  async diff(taskId: string): Promise<string> {
    const task = this.options.harness.list().find((candidate) => candidate.id === taskId);
    if (!task) throw new CoreError("DASHBOARD_AGENT_TASK_NOT_FOUND", "That dashboard agent task is no longer available.");
    const location = await resolveProjectLocation(task.configPath);
    return readDashboardAgentDiff(location.projectRoot, location.configDirectory, task.purpose === "project" ? "project" : "dashboard");
  }

  private supervisor(command: string, location: ProjectLocation): DashboardSetupSupervisor {
    const { runtime, harness } = this.options;
    return new DashboardSetupSupervisor({ runtime, harness, command, location, preflight: assertAgentAvailable });
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
    const command = await this.chosenCommand(source.configPath, request.agent);
    const dashboardWork = template.scope === "dashboard";
    return this.supervisor(command, sourceLocation).launchRequest({
      prompt,
      // Project work is reviewed as a project diff; only dashboard work is
      // validated and may receive the single automatic repair.
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
    // untrusted repair runs the app-configured agent with no project-controlled
    // input: no bundle `.env`, no project instructions in the prompt, and no
    // capability grant. The project stays untrusted until the ordinary review.
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
    const { runtime, harness } = this.options;
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
    if (harness.list().some((task) => task.configPath === configPath
      && task.purpose !== undefined
      && (isProcessRunActive(task.process)
        || task.validation?.status === "checking" || task.validation?.status === "repairing"))) {
      throw new CoreError("DASHBOARD_SETUP_RUNNING", "Setup is already active for this dashboard. Open Agent work to view or stop it.");
    }
    const sourceLocation = await resolveProjectLocation(configPath);
    const command = await this.command(configPath);
    if (runtime.getSessionToken() !== session) throw new CoreError("DASHBOARD_SETUP_STALE", "The active dashboard changed. Run setup from its current panel.");
    return this.supervisor(command, sourceLocation).launch(node);
  }
}
