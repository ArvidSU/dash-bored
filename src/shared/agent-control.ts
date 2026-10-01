import type { ComponentActionChoice } from "./contracts";

/**
 * Contract of the running app's local agent-control channel. The renderer owns
 * view and action state; main relays these shapes between the socket and the
 * webview without widening what a palette action may do.
 */

export interface AgentActionDescriptor {
  id: string;
  reference?: string;
  label: string;
  description?: string;
  group: string;
  source?: string;
  enabled: boolean;
  active?: boolean;
  disabledReason?: string;
  choices?: readonly ComponentActionChoice[];
  /** Set when the channel will refuse this action; the user must run it. */
  refusal?: string;
}

export interface AgentViewState {
  view: "dashboard" | "settings";
  configPath: string | null;
  dashboardName: string | null;
  focusedNodeId: string | null;
  editing: boolean;
  diagnostics: { errors: number; warnings: number };
}

/** Where a node sits in the webview, in CSS pixels from the viewport's top-left. */
export interface AgentNodeMeasurement {
  nodeId: string;
  /** The node's visible bounds, clipped to the viewport and to scrolling ancestors. */
  rect: { x: number; y: number; width: number; height: number };
  /** The node's full, unclipped size; larger than `rect` when `truncated`. */
  fullWidth: number;
  fullHeight: number;
  truncated: boolean;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  /** View changes made to show the node; they are undone after capture. */
  changes: { revealed: boolean; scrolled: boolean };
}

export interface AgentRunActionRequest {
  reference: string;
  selections?: Readonly<Record<string, string>>;
}

export type AgentRunActionResult =
  | { status: "completed"; id: string }
  | { status: "refused" | "unavailable" | "running" | "failed"; id?: string; reason: string };

export interface AgentActionPolicyInput {
  id: string;
  confirmation?: unknown;
}

/**
 * Trust, the user's draft lifecycle, and native file choosers are user
 * decisions, as is anything that asks for confirmation in the palette.
 */
const USER_ONLY_ACTION_IDS = new Set([
  "project:trust",
  "project:revoke-trust",
  "project:edit",
  "project:save-draft",
  "project:cancel-edit",
  "app:add-dashboard",
]);

export function agentActionRefusal(action: AgentActionPolicyInput): string | undefined {
  if (action.id.startsWith("agent:")) {
    return "Agent actions require a user review and cannot be run through the agent-control channel.";
  }
  if (USER_ONLY_ACTION_IDS.has(action.id)) {
    return "This action is reserved for the user. Ask them to run it from the command palette.";
  }
  if (action.confirmation) {
    return "This action asks for confirmation in the palette. Ask the user to run and confirm it.";
  }
  return undefined;
}

export interface AppInstanceRecord {
  identifier: string;
  pid: number;
  version: string;
  socketPath: string;
  toolPath: string | null;
  startedAt: string;
}
