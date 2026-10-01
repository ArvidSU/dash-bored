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

export interface AgentRunActionRequest {
  reference: string;
  selections?: Readonly<Record<string, string>>;
}

export type AgentRunActionResult =
  /** `process: "started"` marks a command start; it keeps running after the run returns. */
  | { status: "completed"; id: string; process?: "started" }
  | { status: "refused" | "running" | "failed"; id?: string; reason: string }
  | { status: "unavailable"; id?: string; reason: string; suggestions?: string[] };

/** Bounds of the idle wait that follows a run or precedes a capture. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
export const MAX_IDLE_TIMEOUT_MS = 60_000;

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

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Up to `limit` known action ids or references close to a mistyped one. */
export function suggestActions(
  reference: string,
  candidates: readonly { id: string; reference?: string }[],
  limit = 5,
): string[] {
  const wanted = reference.toLowerCase();
  const tail = wanted.slice(wanted.indexOf(":") + 1);
  const scored: { name: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const name = candidate.reference ?? candidate.id;
    if (seen.has(name)) continue;
    const values = [candidate.id, candidate.reference]
      .filter((value): value is string => value !== undefined)
      .map((value) => value.toLowerCase());
    let score = Number.POSITIVE_INFINITY;
    for (const value of values) {
      if (value.includes(wanted) || (wanted.length >= 4 && wanted.includes(value))) {
        score = Math.min(score, Math.abs(value.length - wanted.length));
        continue;
      }
      const distance = Math.min(
        editDistance(wanted, value),
        editDistance(tail, value.slice(value.indexOf(":") + 1)),
      );
      if (distance <= Math.max(3, Math.floor(wanted.length / 3))) score = Math.min(score, 1000 + distance);
    }
    if (score === Number.POSITIVE_INFINITY) continue;
    seen.add(name);
    scored.push({ name, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, limit).map(({ name }) => name);
}

export function unknownActionReason(reference: string, suggestions: readonly string[]): string {
  const close = suggestions.length ? ` Close matches: ${suggestions.join(", ")}.` : "";
  return `No action matches ${reference}.${close} Run \`dash-bored app actions <filter>\` to search the available actions.`;
}
