import type { ReactNode } from "react";
import type { AgentPlanEntry, AgentSessionState, AgentSessionTask } from "../../shared/agent-session";
import {
  AGENT_STATE_LABELS,
  AGENT_TOOL_STATUS_LABELS,
  agentStateTone,
  agentValidationLabel,
  agentValidationTone,
  isAgentStateInProgress,
  type AgentToolEntry,
} from "../lib/agent-tasks";

/*
 * Agent state grammar: every state has a color family, a distinct shape, and
 * text. Only in-progress shapes move, and only without reduced motion.
 */

type GlyphName = "progress" | "attention" | "lock" | "ready" | "stopped" | "failed" | "done" | "pending" | "half" | "info";

function Glyph({ name, spin = false }: { name: GlyphName; spin?: boolean }): ReactNode {
  const shape = (() => {
    switch (name) {
      case "progress": return (
        <>
          <circle cx="8" cy="8" r="5.5" opacity="0.28" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
        </>
      );
      case "attention": return (
        <>
          <path d="M8 1.9 14.1 8 8 14.1 1.9 8Z" />
          <path d="M8 5.3v3.2" />
          <circle cx="8" cy="10.7" r="0.55" fill="currentColor" />
        </>
      );
      case "lock": return (
        <>
          <rect x="3.8" y="7.2" width="8.4" height="6.3" rx="1.3" />
          <path d="M5.7 7.2V5.5a2.3 2.3 0 0 1 4.6 0v1.7" />
        </>
      );
      case "ready": return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="1.9" fill="currentColor" stroke="none" />
        </>
      );
      case "stopped": return <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.3" />;
      case "failed": return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m6 6 4 4m0-4-4 4" />
        </>
      );
      case "done": return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m5.6 8.2 1.7 1.7 3.2-3.5" />
        </>
      );
      case "half": return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none" />
        </>
      );
      case "info": return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 7.4v3.4" />
          <circle cx="8" cy="5.2" r="0.55" fill="currentColor" />
        </>
      );
      default: return <circle cx="8" cy="8" r="5.5" />;
    }
  })();
  return (
    <svg className={spin ? "agent-glyph agent-glyph--spin" : "agent-glyph"} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {shape}
    </svg>
  );
}

function stateGlyph(state: AgentSessionState): GlyphName {
  switch (state) {
    case "starting":
    case "working": return "progress";
    case "waiting": return "attention";
    case "auth-required": return "lock";
    case "idle": return "ready";
    case "failed": return "failed";
    default: return "stopped";
  }
}

export function AgentStateChip({ state }: { state: AgentSessionState }): ReactNode {
  return (
    <span className={`agent-chip agent-chip--${agentStateTone(state)}`} data-state={state}>
      <Glyph name={stateGlyph(state)} spin={isAgentStateInProgress(state)} />
      <span>{AGENT_STATE_LABELS[state]}</span>
    </span>
  );
}

export function AgentValidationChip({ task }: { task: Pick<AgentSessionTask, "validation"> }): ReactNode {
  const label = agentValidationLabel(task);
  if (!label) return null;
  const tone = agentValidationTone(task);
  const glyph: GlyphName = tone === "progress" ? "progress"
    : tone === "positive" ? "done"
      : tone === "negative" ? "failed"
        : tone === "attention" ? "attention"
          : "stopped";
  return (
    <span className={`agent-chip agent-chip--validation agent-chip--${tone}`} data-validation={task.validation?.status}>
      <Glyph name={glyph} spin={tone === "progress"} />
      <span>{label}</span>
    </span>
  );
}

export function AgentToolStatus({ status }: { status: AgentToolEntry["status"] }): ReactNode {
  const glyph: GlyphName = status === "completed" ? "done" : status === "failed" ? "failed" : status === "in_progress" ? "progress" : "pending";
  return (
    <span className={`agent-tool-status agent-tool-status--${status}`}>
      <Glyph name={glyph} spin={status === "in_progress"} />
      <span>{AGENT_TOOL_STATUS_LABELS[status]}</span>
    </span>
  );
}

export function AgentPlanStatusGlyph({ status }: { status: AgentPlanEntry["status"] }): ReactNode {
  return <Glyph name={status === "completed" ? "done" : status === "in_progress" ? "half" : "pending"} />;
}

export function AgentNoticeGlyph({ level }: { level: "info" | "warning" | "error" }): ReactNode {
  return <Glyph name={level === "error" ? "failed" : level === "warning" ? "attention" : "info"} />;
}

export function AgentAttentionGlyph(): ReactNode {
  return <Glyph name="attention" />;
}

export function AgentLockGlyph(): ReactNode {
  return <Glyph name="lock" />;
}
