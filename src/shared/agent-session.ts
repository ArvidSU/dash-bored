import type { AgentPromptTemplateSummary, Diagnostic } from "./contracts";

/*
 * Agent work as the app presents it. The main process owns one Agent Client
 * Protocol (ACP) connection per task and publishes this bounded projection.
 * These types are app-internal: they are deliberately not part of
 * `contracts.ts`, whose declarations ship in the component SDK.
 */

/** One known ACP agent. Data only: no code path may branch on `id`. */
export interface KnownAgent {
  id: string;
  name: string;
  /** ACP launch command; its first token is looked up on PATH for detection. */
  command: string;
  /** The agent's own CLI executable, used for hand-off and legacy-command hints. */
  cli?: string;
  /**
   * npm package that runs `command` through `npx`/`bunx`, so a custom
   * `npx <package>` command is recognized as this agent. Never installed.
   */
  package?: string;
  /**
   * Native command that resumes an ACP session in the agent's own app, run
   * from the project root. Placeholders: `{sessionId}` and `{cwd}` (the
   * project root); each is substituted as one shell-quoted word.
   */
  resume?: string;
  /** Where to get the agent; shown when it is not detected. */
  homepage: string;
}

/** A known agent whose launch executable was found on the app's PATH. */
export interface DetectedAgent {
  id: string;
  name: string;
  command: string;
  /** The agent defines a resume command for hand-off. */
  resumable: boolean;
}

/**
 * Which agent runs one composer launch. Omitted means the effective choice:
 * the app setting, else the owning bundle's `.env`, else the first detected agent.
 * `detected` names a known agent; the main process re-resolves its command.
 */
export type AgentCommandChoice =
  | { source: "app" }
  | { source: "project" }
  | { source: "detected"; id: string }
  | { source: "custom"; command: string };

/** The agents a composer or Settings can pick from, resolved by the main process. */
export interface AgentCommandOptions {
  /** The app-wide setting, or null when agent selection returns to the bundle. */
  app: string | null;
  /** The owning bundle's `.env` DASH_BORED_AGENT, when it sets one. */
  project: string | null;
  /** Known agents found on PATH, in catalog order. */
  detected: DetectedAgent[];
  /** The full known-agent table, for install hints. */
  known: KnownAgent[];
  /** What an omitted choice runs, or null when no agent is configured or detected. */
  effective: { source: "app" | "project" | "detected"; command: string; name: string } | null;
}

export interface ComponentAgentRequest {
  /**
   * Target components in pick order, never empty. All must belong to one
   * dashboard bundle; the first is the template's `component`.
   */
  nodeIds: string[];
  /** The user's reviewed input; rendered into the template as `{{input}}`. */
  prompt: string;
  /** Prompt template name; Change with agent uses `dashboard`, `agent:prompt` defaults to `project`. */
  template?: string;
  vars?: Record<string, string | number | boolean>;
  agent?: AgentCommandChoice;
}

export interface ComponentAgentPreview {
  template: AgentPromptTemplateSummary;
  /** The complete first prompt the agent would receive. */
  prompt: string;
  /** Every template the owning bundle offers, built-ins first, for the composer's picker. */
  templates: AgentPromptTemplateSummary[];
  agents: AgentCommandOptions;
}

export interface DashboardSetupAgentRequest {
  nodeId: string;
}

export interface ComponentCreationAgentRequest {
  configPath: string;
  target: import("./contracts").DashboardInsertionTarget;
  prompt: string;
}

/** Every way the renderer can start agent work; one host command launches them all. */
export type AgentLaunchRequest =
  | ({ kind: "component" } & ComponentAgentRequest)
  | ({ kind: "creation" } & ComponentCreationAgentRequest)
  | { kind: "diagnostics" }
  | ({ kind: "setup" } & DashboardSetupAgentRequest);

export type AgentSessionState =
  /** Spawning the agent, initializing ACP, and creating the session. */
  | "starting"
  /** The agent needs the user to sign in before a session can start. */
  | "auth-required"
  /** A prompt turn is running. */
  | "working"
  /** A prompt turn is blocked on a permission request. */
  | "waiting"
  /** The last turn ended; follow-up prompts are accepted. */
  | "idle"
  /** The session ended: closed by the user, handed off, or stopped by the app. */
  | "closed"
  /** The agent process or protocol failed; see `error` and `log`. */
  | "failed";

export type AgentToolKind =
  | "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type AgentStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface AgentLocation {
  path: string;
  line?: number;
}

/** One transcript entry. Message chunks with the same id are merged into one entry. */
export type AgentSessionEntry =
  | { kind: "user"; id: string; text: string }
  /** Markdown text from the agent. */
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | {
      kind: "tool";
      /** The ACP toolCallId. */
      id: string;
      title: string;
      toolKind: AgentToolKind;
      status: "pending" | "in_progress" | "completed" | "failed";
      locations: AgentLocation[];
      /** Files an ACP diff touched, summarized; the app renders no diffs. */
      edits: Array<{ path: string; added: number; removed: number }>;
      /** Bounded text content the agent attached to the call. */
      output?: string;
    }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string };

export interface AgentPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AgentPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** A pending `session/request_permission`; the agent is blocked until it is answered. */
export interface AgentPermissionRequest {
  /** App-generated id; answers must name it so a stale click cannot answer a newer request. */
  id: string;
  toolCallId: string;
  title: string;
  toolKind?: AgentToolKind;
  locations: AgentLocation[];
  options: AgentPermissionOption[];
}

/** An ACP session config option (model, mode, reasoning level, ...). */
export interface AgentConfigOption {
  id: string;
  name: string;
  description?: string;
  /** ACP category hint such as `mode`, `model`, `model_config`, or `thought_level`. */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: Array<{ value: string; name: string; description?: string; group?: string }>;
}

export interface AgentAuthMethod {
  id: string;
  name: string;
  description?: string;
}

/** One request to the user's agent, for dashboard or project work: one ACP session. */
export interface AgentSessionTask {
  id: string;
  purpose?: "setup" | "edit" | "migration" | "repair" | "project";
  /** Prompt template the request was rendered from, when it came from one. */
  template?: string;
  agent: {
    /** The ACP launch command that runs. */
    command: string;
    /** Display name: the known agent's name, or the command's executable. */
    name: string;
    knownId?: string;
  };
  /** The fully contextualized first prompt. */
  prompt: string;
  componentPath: string;
  /** The user's request, for the drawer summary. */
  request: string;
  configPath: string;
  startedAt: string;
  state: AgentSessionState;
  sessionId: string | null;
  pid: number | null;
  /** Bounded transcript, oldest first. */
  entries: AgentSessionEntry[];
  /** Entries dropped from the front to keep the transcript bounded. */
  truncated: number;
  /** The agent's latest plan; ACP replaces it whole on every update. */
  plan: AgentPlanEntry[] | null;
  permission: AgentPermissionRequest | null;
  configOptions: AgentConfigOption[];
  /** Completed prompt turns. */
  turns: number;
  stopReason?: AgentStopReason;
  /** Sign-in methods the agent offers while `state` is `auth-required`. */
  auth?: AgentAuthMethod[];
  /**
   * The native resume command for hand-off, resolved for this session, or null
   * when the agent defines none, the session has no id, or no turn has
   * completed yet (some agents persist a session only after its first turn).
   */
  handoff: { command: string; app: string } | null;
  /** The session was handed off to the agent's own app. */
  handedOff?: boolean;
  /** The dashboard changed while a turn was running; it is not a success claim. */
  dashboardChanged: boolean;
  /** Explicitly stopped by the user or application shutdown. */
  cancelled?: boolean;
  /** Untrusted repair: permission requests outside the bundle are refused automatically. */
  untrusted?: boolean;
  error?: string;
  /** Bounded agent stderr tail, for troubleshooting launch and protocol failures. */
  log: string[];
  validation?: {
    status: "checking" | "repairing" | "valid" | "failed" | "trust-required" | "cancelled";
    diagnostics: Diagnostic[];
    message?: string;
  };
}

/**
 * Agent work is in progress: the session is starting, waiting for sign-in,
 * running or blocked in a turn, or the app is validating or repairing its
 * result. `auth-required` counts as busy because a prompt is pending and runs
 * as soon as the user signs in. An idle session is not busy: it holds only a
 * process the app stops on close or quit.
 */
export function isAgentTaskBusy(task: Pick<AgentSessionTask, "state" | "validation">): boolean {
  return task.state === "starting" || task.state === "auth-required" || task.state === "working" || task.state === "waiting"
    || task.validation?.status === "checking" || task.validation?.status === "repairing";
}

/** One command to an agent task; the host answers with the task afterwards. */
export type AgentTaskCommand =
  /** A follow-up prompt; accepted only while the session is idle. */
  | { type: "prompt"; text: string }
  /** Cancel the running turn (`session/cancel`); the session stays open. */
  | { type: "cancel" }
  /** Answer the pending permission request; `null` dismisses it as cancelled. */
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "config"; configId: string; value: string | boolean }
  | { type: "authenticate"; methodId: string }
  /** Resume the session in the agent's own app; the app then lets go of the session. */
  | { type: "handoff" }
  /** End the session and stop the agent process. */
  | { type: "close" };
