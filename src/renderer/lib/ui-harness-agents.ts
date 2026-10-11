import { KNOWN_AGENTS } from "../../shared/agent-catalog";
import type {
  AgentCommandChoice,
  AgentCommandOptions,
  AgentConfigOption,
  AgentPermissionRequest,
  AgentSessionEntry,
  AgentSessionTask,
  AgentStopReason,
  AgentTaskCommand,
  DetectedAgent,
} from "../../shared/agent-session";
import type { ComponentAgentLaunch } from "../../shared/contracts";

/*
 * Deterministic ACP sessions for the UI fixture (`bun run ui:fixture` and the
 * renderer interaction tests). The fixture starts with one session in each
 * interesting state and answers task commands the way the main process's ACP
 * session manager is expected to: a follow-up runs a short turn, permission
 * answers resume or end the turn, hand-off closes the session, and so on.
 */

/** Delay before a simulated turn ends, so tests and reviewers can see Working. */
const TURN_MS = 350;

export interface FixtureAgentLaunch {
  purpose?: AgentSessionTask["purpose"];
  template?: string;
  request: string;
  prompt: string;
  componentPath: string;
  agent?: AgentCommandChoice;
}

export interface FixtureAgentControls {
  /** Ends the task's running turn: idle, one more completed turn, and the given validation. */
  finishAgentTask(taskId: string, validation: NonNullable<AgentSessionTask["validation"]>): Promise<void>;
  /** Streams agent text into the transcript, merged into a trailing agent message. */
  appendAgentMessage(taskId: string, text: string): Promise<void>;
  /**
   * Puts a permission request on the task; it starts waiting on the user. While
   * another request is open the new one queues behind it, as an agent's
   * parallel tool calls do, and appears once the open one is answered.
   */
  requestAgentPermission(taskId: string, permission?: Partial<AgentPermissionRequest>): Promise<void>;
  /** Applies a raw patch to a task and publishes it, for state transitions tests need. */
  patchAgentTask(taskId: string, patch: Partial<AgentSessionTask>): Promise<void>;
  /** Every task command the UI sent, oldest first. */
  getAgentTaskCommands(): readonly { taskId: string; command: AgentTaskCommand }[];
  /**
   * Simulates host latency for task commands: the answer arrives `responseMs`
   * after the command and the task push `pushMs` after it, so a push can trail
   * the answer. Both carry the task as it is when they are sent. Zero (the
   * default) answers at once and pushes before answering.
   */
  setAgentCommandLatency(latency: { responseMs?: number; pushMs?: number }): void;
  /** Known agent IDs found on the fixture PATH. */
  setDetectedAgents(ids: readonly string[]): void;
}

export interface FixtureAgents extends FixtureAgentControls {
  getAgentTasks(): Promise<AgentSessionTask[]>;
  agentTaskCommand(taskId: string, command: AgentTaskCommand): Promise<AgentSessionTask>;
  getAgentOptions(configPath?: string): Promise<AgentCommandOptions>;
  launch(request: FixtureAgentLaunch): ComponentAgentLaunch;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentIdentity(command: string): AgentSessionTask["agent"] {
  const trimmed = command.trim();
  const known = KNOWN_AGENTS.find((agent) => agent.command === trimmed);
  return known
    ? { command: trimmed, name: known.name, knownId: known.id }
    : { command: trimmed, name: trimmed.split(/\s+/)[0] ?? trimmed };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function modelOptions(current: string): AgentConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: [
      { value: "default", name: "Default (recommended)" },
      { value: "sonnet", name: "Sonnet", group: "Claude" },
      { value: "opus", name: "Opus", group: "Claude" },
      { value: "haiku", name: "Haiku", group: "Claude" },
    ],
  };
}

function seededTasks(projectRoot: string, configPath: string): AgentSessionTask[] {
  const repository = projectRoot.replace(/\/\.dash-bored$/, "");
  const base = {
    configPath,
    truncated: 0,
    dashboardChanged: false,
    log: [] as string[],
  };
  return [
    {
      ...base,
      id: "fixture-working",
      purpose: "edit",
      template: "dashboard",
      agent: agentIdentity("claude-agent-acp"),
      prompt: "You were asked to change one dashboard component.\n\nTarget component id: status\n\nUser request:\nAdd a deploy status beside the fixture status and keep the layout compact. Validate the dashboard afterwards.",
      componentPath: `${configPath}#id=status`,
      request: "Add a deploy status beside the fixture status and keep the layout compact. Validate the dashboard afterwards.",
      startedAt: minutesAgo(4),
      state: "working",
      sessionId: "c0ffee00-claude-session",
      pid: 41001,
      entries: [
        {
          kind: "thought",
          id: "t1",
          text: "The user wants a deploy status next to the existing status tile.\nRead dash-bored.yaml first, then add a status node with a shell source.",
        },
        { kind: "tool", id: "call-read", title: "Read dash-bored.yaml", toolKind: "read", status: "completed", locations: [{ path: configPath }], edits: [] },
        {
          kind: "agent",
          id: "m1",
          text: "I'll add a **deploy status** next to `Fixture status`:\n\n1. Add a `status` node fed by a small shell source.\n2. Keep the group's split ratio so the layout stays *compact*.\n3. Validate with `dash-bored validate`.",
        },
        {
          kind: "tool",
          id: "call-script",
          title: "Write scripts/deploy-status.sh",
          toolKind: "edit",
          status: "completed",
          locations: [],
          edits: [{ path: `${projectRoot}/scripts/deploy-status.sh`, added: 9, removed: 0 }],
        },
        {
          kind: "tool",
          id: "call-edit",
          title: "Edit dash-bored.yaml",
          toolKind: "edit",
          status: "in_progress",
          locations: [{ path: configPath, line: 42 }],
          edits: [{ path: configPath, added: 14, removed: 2 }],
        },
        {
          kind: "agent",
          id: "m2",
          text: "The source prints `{ state, detail }` from the latest deploy tag:\n\n```sh\ngit describe --tags --abbrev=0\n```\n\nNow wiring it into the group",
        },
      ],
      plan: [
        { content: "Read the dashboard and find the fixture status", priority: "medium", status: "completed" },
        { content: "Add a deploy status with a shell source", priority: "high", status: "in_progress" },
        { content: "Validate the dashboard", priority: "medium", status: "pending" },
      ],
      permission: null,
      configOptions: [
        modelOptions("sonnet"),
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Ask before edits" },
            { value: "acceptEdits", name: "Accept edits" },
            { value: "plan", name: "Plan only" },
          ],
        },
        { id: "thinking", name: "Extended thinking", category: "thought_level", type: "boolean", currentValue: true },
      ],
      turns: 0,
      handoff: null,
      dashboardChanged: true,
    },
    {
      ...base,
      id: "fixture-waiting",
      purpose: "project",
      template: "project",
      agent: agentIdentity("codex-acp"),
      prompt: "You were asked to do work in this project.\n\nUser request:\nFix the failing release checklist test. Keep the change small.",
      componentPath: `${configPath}#id=renderer-proof-todos`,
      request: "Fix the failing release checklist test. Keep the change small.",
      startedAt: minutesAgo(9),
      state: "waiting",
      sessionId: "0199a7c2-codex-session",
      pid: 41002,
      entries: [
        {
          kind: "agent",
          id: "m1",
          text: "The release checklist test fails because its fixture date is in the past. I'll run the focused test to confirm before changing anything.",
        },
        { kind: "tool", id: "call-test", title: "bun test tests/release/checklist.test.ts", toolKind: "execute", status: "pending", locations: [], edits: [] },
      ],
      plan: null,
      permission: {
        id: "perm-fixture-1",
        toolCallId: "call-test",
        title: "Run bun test tests/release/checklist.test.ts",
        toolKind: "execute",
        locations: [{ path: `${repository}/tests/release/checklist.test.ts` }],
        options: [
          { optionId: "approved", name: "Allow once", kind: "allow_once" },
          { optionId: "approved-for-session", name: "Always allow", kind: "allow_always" },
          { optionId: "abort", name: "Reject", kind: "reject_once" },
        ],
      },
      configOptions: [
        {
          id: "reasoning",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
      turns: 1,
      handoff: null,
    },
    {
      ...base,
      id: "fixture-idle",
      purpose: "edit",
      template: "dashboard",
      agent: agentIdentity("gemini --acp"),
      prompt: "You were asked to change one dashboard component.\n\nTarget component id: renderer-proof-todos\n\nUser request:\nSummarize the open backlog items in a list beside the todos.",
      componentPath: `${configPath}#id=renderer-proof-todos`,
      request: "Summarize the open backlog items in a list beside the todos.",
      startedAt: minutesAgo(26),
      state: "idle",
      sessionId: "4f6c1d2e-gemini-session",
      pid: 41003,
      entries: [
        { kind: "agent", id: "m1", text: "Looking for the backlog first." },
        {
          kind: "tool",
          id: "call-search",
          title: "Search for TODO",
          toolKind: "search",
          status: "completed",
          locations: [],
          edits: [],
          output: "3 matches\n.dash-bored/dash-bored.yaml:88:  todos:\n.dash-bored/scripts/backlog.sh:4: # TODO: include labels\nREADME.md:12: ## TODO",
        },
        {
          kind: "tool",
          id: "call-edit",
          title: "Edit dash-bored.yaml",
          toolKind: "edit",
          status: "completed",
          locations: [],
          edits: [{ path: configPath, added: 22, removed: 0 }],
        },
        {
          kind: "agent",
          id: "m2",
          text: "Added an **Open work** list beside the todos.\n\n| Item | State |\n| --- | --- |\n| Keep this surface mounted | open |\n\nThe list reads `scripts/backlog.sh`; see [the list docs](https://example.com/docs/list) for item actions. <b>Raw HTML stays text.</b>",
        },
        { kind: "notice", id: "n1", level: "info", text: "Dashboard validated after the turn." },
      ],
      plan: [
        { content: "Find the backlog source", priority: "medium", status: "completed" },
        { content: "Add the Open work list", priority: "medium", status: "completed" },
      ],
      permission: null,
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "auto_edit", name: "Auto edit" },
            { value: "yolo", name: "YOLO" },
          ],
        },
      ],
      turns: 2,
      stopReason: "end_turn",
      handoff: { command: `gemini --resume ${quote("4f6c1d2e-gemini-session")}`, app: "Gemini CLI" },
      validation: { status: "valid", diagnostics: [] },
    },
    {
      ...base,
      id: "fixture-auth",
      purpose: "edit",
      template: "dashboard",
      agent: agentIdentity("copilot --acp"),
      prompt: "You were asked to change one dashboard component.\n\nUser request:\nAdd a pull request list for this repository.",
      componentPath: `${configPath}#id=status`,
      request: "Add a pull request list for this repository.",
      startedAt: minutesAgo(31),
      state: "auth-required",
      sessionId: null,
      pid: 41004,
      entries: [],
      plan: null,
      permission: null,
      configOptions: [],
      turns: 0,
      auth: [{ id: "github-oauth", name: "Sign in with GitHub", description: "Opens github.com in your browser." }],
      handoff: null,
    },
    {
      ...base,
      id: "fixture-failed",
      purpose: "edit",
      template: "dashboard",
      agent: agentIdentity("my-acp-agent --stdio"),
      prompt: "You were asked to change one dashboard component.\n\nUser request:\nTidy the dashboard tabs.",
      componentPath: `${configPath}#id=harness-root`,
      request: "Tidy the dashboard tabs.",
      startedAt: minutesAgo(48),
      state: "failed",
      sessionId: null,
      pid: null,
      entries: [],
      plan: null,
      permission: null,
      configOptions: [],
      turns: 0,
      handoff: null,
      error: "The agent did not answer ACP initialize within 60 seconds. Check that `my-acp-agent --stdio` starts an ACP agent over stdio.",
      log: [
        "my-acp-agent 0.3.1",
        "loading config from ~/.config/my-acp-agent/config.toml",
        "warning: no model configured, using default",
        "listening for commands on stdin",
        "> help",
        "unknown input: {\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\"}",
        "hint: run with --acp to speak the Agent Client Protocol",
      ],
    },
  ];
}

export function createFixtureAgents({
  projectRoot,
  configPath,
  appAgent,
  projectAgent,
  publish,
}: {
  projectRoot: string;
  configPath: string;
  /** The app-wide agent setting. */
  appAgent(): string | null;
  /** The bundle `.env` DASH_BORED_AGENT. */
  projectAgent(): string | null;
  publish(task: AgentSessionTask): void;
}): FixtureAgents {
  const tasks: AgentSessionTask[] = seededTasks(projectRoot, configPath);
  const commands: { taskId: string; command: AgentTaskCommand }[] = [];
  /** Requests waiting behind each task's open permission request, oldest first. */
  const queuedPermissions = new Map<string, AgentPermissionRequest[]>();
  let latency = { responseMs: 0, pushMs: 0 };
  let detectedIds: readonly string[] = ["claude", "codex", "gemini"];
  let launches = 0;
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;

  const emit = (task: AgentSessionTask): void => publish(structuredClone(task));
  const find = (taskId: string): AgentSessionTask => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("That agent session is no longer available.");
    return task;
  };

  const options = (): AgentCommandOptions => {
    const app = appAgent()?.trim() || null;
    const project = projectAgent()?.trim() || null;
    const detected: DetectedAgent[] = KNOWN_AGENTS
      .filter((agent) => detectedIds.includes(agent.id))
      .map((agent) => ({ id: agent.id, name: agent.name, command: agent.command, resumable: agent.resume !== undefined }));
    const effective = app
      ? { source: "app" as const, command: app, name: agentIdentity(app).name }
      : project
        ? { source: "project" as const, command: project, name: agentIdentity(project).name }
        : detected[0]
          ? { source: "detected" as const, command: detected[0].command, name: detected[0].name }
          : null;
    return { app, project, detected, known: structuredClone([...KNOWN_AGENTS]), effective };
  };

  const resolveCommand = (choice: AgentCommandChoice | undefined): string => {
    const current = options();
    if (!choice) {
      if (!current.effective) throw new Error("AGENT_UNAVAILABLE: No ACP agent is configured or detected. Choose one in Settings.");
      return current.effective.command;
    }
    switch (choice.source) {
      case "app":
        if (!current.app) throw new Error("No app-wide agent is set.");
        return current.app;
      case "project":
        if (!current.project) throw new Error("This dashboard's .env does not set DASH_BORED_AGENT.");
        return current.project;
      case "detected": {
        const agent = current.detected.find((candidate) => candidate.id === choice.id);
        if (!agent) throw new Error("That agent is no longer detected on PATH.");
        return agent.command;
      }
      case "custom":
        if (!choice.command.trim()) throw new Error("The custom agent command is empty.");
        return choice.command.trim();
    }
  };

  const handoffFor = (task: AgentSessionTask): AgentSessionTask["handoff"] => {
    const known = KNOWN_AGENTS.find((agent) => agent.id === task.agent.knownId);
    if (!known?.resume || !task.sessionId || task.turns === 0) return null;
    const command = known.resume
      .replaceAll("{sessionId}", quote(task.sessionId))
      .replaceAll("{cwd}", quote(projectRoot.replace(/\/\.dash-bored$/, "")));
    return { command, app: known.name };
  };

  const appendAgent = (task: AgentSessionTask, text: string): void => {
    const last = task.entries.at(-1);
    if (last?.kind === "agent") last.text += text;
    else task.entries.push({ kind: "agent", id: nextId("m"), text });
  };

  const endTurn = (task: AgentSessionTask, stopReason: AgentStopReason): void => {
    task.state = "idle";
    task.permission = null;
    queuedPermissions.delete(task.id);
    task.stopReason = stopReason;
    if (stopReason === "end_turn") task.turns += 1;
    for (const entry of task.entries) {
      if (entry.kind === "tool" && (entry.status === "pending" || entry.status === "in_progress")) {
        entry.status = stopReason === "end_turn" ? "completed" : "failed";
      }
    }
    if (task.plan && stopReason === "end_turn") task.plan = task.plan.map((entry) => ({ ...entry, status: "completed" }));
    task.handoff = handoffFor(task);
  };

  const finishTurnLater = (task: AgentSessionTask, text: string): void => {
    setTimeout(() => {
      if (task.state !== "working") return;
      appendAgent(task, text);
      endTurn(task, "end_turn");
      emit(task);
    }, TURN_MS);
  };

  const toolEntry = (task: AgentSessionTask, toolCallId: string) =>
    task.entries.find((entry): entry is Extract<AgentSessionEntry, { kind: "tool" }> => entry.kind === "tool" && entry.id === toolCallId);

  async function agentTaskCommand(taskId: string, command: AgentTaskCommand): Promise<AgentSessionTask> {
    const task = find(taskId);
    commands.push({ taskId, command: structuredClone(command) });
    switch (command.type) {
      case "prompt": {
        if (task.state !== "idle") throw new Error("The agent is busy; send the follow-up when its turn ends.");
        if (!command.text.trim()) throw new Error("A follow-up needs text.");
        task.entries.push({ kind: "user", id: nextId("u"), text: command.text });
        task.state = "working";
        task.handoff = null;
        task.stopReason = undefined;
        finishTurnLater(task, `Done. I handled the follow-up: ${command.text.trim().split("\n", 1)[0]}`);
        break;
      }
      case "cancel": {
        if (task.state === "working" || task.state === "waiting") {
          task.entries.push({ kind: "notice", id: nextId("n"), level: "warning", text: "You stopped the turn." });
          endTurn(task, "cancelled");
        } else if (task.validation?.status === "checking") {
          task.cancelled = true;
          task.validation = { ...task.validation, status: "cancelled" };
        }
        break;
      }
      case "permission": {
        const request = task.permission;
        if (!request || request.id !== command.requestId) throw new Error("That permission request was already answered.");
        const option = command.optionId === null ? null : request.options.find((candidate) => candidate.optionId === command.optionId);
        if (command.optionId !== null && !option) throw new Error("That permission option is not available.");
        const tool = toolEntry(task, request.toolCallId);
        task.permission = null;
        const queued = option ? queuedPermissions.get(task.id)?.shift() : undefined;
        if (queued) {
          // The next queued request shows at once; the turn waits on it.
          if (tool) tool.status = option?.kind === "reject_once" || option?.kind === "reject_always" ? "failed" : "in_progress";
          task.permission = queued;
          task.state = "waiting";
        } else if (!option) {
          task.entries.push({ kind: "notice", id: nextId("n"), level: "warning", text: "Permission request dismissed; the turn was cancelled." });
          endTurn(task, "cancelled");
        } else if (option.kind === "reject_once" || option.kind === "reject_always") {
          if (tool) tool.status = "failed";
          task.state = "working";
          finishTurnLater(task, "Understood, I left that alone. Tell me how you'd like to proceed.");
        } else {
          if (tool) {
            tool.status = "in_progress";
            tool.output = "bun test v1.3.14\n\n tests/release/checklist.test.ts:\n✓ release checklist dates are in the future [2.10ms]\n\n 1 pass\n 0 fail";
          }
          task.state = "working";
          finishTurnLater(task, "The focused test passes now. I updated the fixture date and kept the change to one line.");
        }
        break;
      }
      case "config": {
        const option = task.configOptions.find((candidate) => candidate.id === command.configId);
        if (!option) throw new Error("That session option is no longer offered.");
        const valid = option.type === "boolean"
          ? typeof command.value === "boolean"
          : typeof command.value === "string" && (option.options ?? []).some((candidate) => candidate.value === command.value);
        if (!valid) throw new Error("That value is not one of the agent's choices.");
        option.currentValue = command.value;
        break;
      }
      case "authenticate": {
        if (task.state !== "auth-required") throw new Error("This session is not waiting for sign-in.");
        if (!(task.auth ?? []).some((method) => method.id === command.methodId)) throw new Error("That sign-in method is not offered.");
        task.auth = undefined;
        task.state = "starting";
        setTimeout(() => {
          if (task.state !== "starting") return;
          task.state = "working";
          task.sessionId = `fixture-session-${task.id}`;
          appendAgent(task, "Signed in. Reading the dashboard…");
          emit(task);
          finishTurnLater(task, " I added the pull request list.");
        }, 120);
        break;
      }
      case "handoff": {
        if (!task.handoff || task.state !== "idle") throw new Error("Hand-off is available when the session is idle.");
        task.state = "closed";
        task.handedOff = true;
        task.pid = null;
        break;
      }
      case "close": {
        if (task.state === "closed") break;
        task.state = "closed";
        task.permission = null;
        queuedPermissions.delete(task.id);
        task.handoff = null;
        task.pid = null;
        break;
      }
    }
    if (latency.pushMs > 0) setTimeout(() => emit(task), latency.pushMs);
    else emit(task);
    if (latency.responseMs > 0) await new Promise((resolve) => setTimeout(resolve, latency.responseMs));
    return structuredClone(task);
  }

  return {
    async getAgentTasks() { return structuredClone(tasks); },
    agentTaskCommand,
    async getAgentOptions(_configPath?: string) { return options(); },
    launch(request) {
      const command = resolveCommand(request.agent);
      launches += 1;
      const task: AgentSessionTask = {
        id: `agent-task-${launches}`,
        ...(request.purpose ? { purpose: request.purpose } : {}),
        ...(request.template ? { template: request.template } : {}),
        agent: agentIdentity(command),
        prompt: request.prompt,
        componentPath: request.componentPath,
        request: request.request,
        configPath,
        startedAt: new Date().toISOString(),
        state: "starting",
        sessionId: null,
        pid: 42000 + launches,
        entries: [],
        truncated: 0,
        plan: null,
        permission: null,
        configOptions: [],
        turns: 0,
        handoff: null,
        dashboardChanged: false,
        log: [],
      };
      tasks.unshift(task);
      emit(task);
      setTimeout(() => {
        if (task.state !== "starting") return;
        task.state = "working";
        task.sessionId = `fixture-session-${task.id}`;
        task.configOptions = [modelOptions("default")];
        // A new ACP message: it never merges into text a test appended earlier.
        task.entries.push({ kind: "agent", id: nextId("m"), text: "Reading the dashboard and the request…" });
        emit(task);
      }, 60);
      return { taskId: task.id, command, componentPath: task.componentPath, pid: task.pid };
    },
    async finishAgentTask(taskId, validation) {
      const task = find(taskId);
      appendAgent(task, "\n\nCreated project workflows and checked the dashboard.");
      endTurn(task, "end_turn");
      task.validation = structuredClone(validation);
      emit(task);
    },
    async appendAgentMessage(taskId, text) {
      const task = find(taskId);
      appendAgent(task, text);
      emit(task);
    },
    async requestAgentPermission(taskId, permission = {}) {
      const task = find(taskId);
      const toolCallId = permission.toolCallId ?? nextId("call");
      if (!toolEntry(task, toolCallId)) {
        task.entries.push({
          kind: "tool",
          id: toolCallId,
          title: permission.title ?? "Edit dash-bored.yaml",
          toolKind: permission.toolKind ?? "edit",
          status: "pending",
          locations: permission.locations ?? [{ path: configPath }],
          edits: [],
        });
      }
      const request: AgentPermissionRequest = {
        id: permission.id ?? nextId("perm"),
        toolCallId,
        title: permission.title ?? "Edit dash-bored.yaml",
        toolKind: permission.toolKind ?? "edit",
        locations: permission.locations ?? [{ path: configPath }],
        options: permission.options ?? [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      };
      if (task.permission) {
        queuedPermissions.set(taskId, [...queuedPermissions.get(taskId) ?? [], request]);
        emit(task);
        return;
      }
      task.permission = request;
      task.state = "waiting";
      task.handoff = null;
      emit(task);
    },
    async patchAgentTask(taskId, patch) {
      const task = find(taskId);
      Object.assign(task, structuredClone(patch));
      emit(task);
    },
    getAgentTaskCommands() { return structuredClone(commands); },
    setAgentCommandLatency(next) { latency = { responseMs: next.responseMs ?? 0, pushMs: next.pushMs ?? 0 }; },
    setDetectedAgents(ids) { detectedIds = [...ids]; },
  };
}
