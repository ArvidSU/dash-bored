import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentSessionEntry,
  AgentSessionTask,
  AgentTaskCommand,
} from "../../shared/agent-session";
import {
  AGENT_TOOL_KIND_LABELS,
  agentDisplayPath,
  agentLocationLabel,
  agentPlanProgress,
  type AgentToolEntry,
} from "../lib/agent-tasks";
import { MarkdownLite } from "../lib/markdown-lite";
import {
  AgentAttentionGlyph,
  AgentLockGlyph,
  AgentNoticeGlyph,
  AgentPlanStatusGlyph,
  AgentToolStatus,
} from "./AgentStatus";

/** Sends one command; resolves false when it failed (the caller shows the error). */
export type AgentSessionSend = (key: string, command: AgentTaskCommand) => Promise<boolean>;

const MAX_FOLLOW_UP = 12_000;
/** Within this distance of the end the transcript follows new output. */
const FOLLOW_SLACK_PX = 32;

/** The Session tab: plan, transcript, what needs the user, and the follow-up composer. */
export function AgentSession({
  task,
  pending,
  onSend,
}: {
  task: AgentSessionTask;
  pending: string | null;
  onSend: AgentSessionSend;
}): ReactNode {
  return (
    <div className="agent-session">
      {task.plan && task.plan.length > 0 ? <AgentPlan plan={task.plan} /> : null}
      <AgentTranscript task={task} />
      {task.permission ? (
        <AgentPermissionCard
          key={task.permission.id}
          permission={task.permission}
          configPath={task.configPath}
          untrusted={task.untrusted === true}
          pending={pending !== null}
          onAnswer={(optionId) => onSend("permission", { type: "permission", requestId: task.permission!.id, optionId })}
        />
      ) : null}
      {task.state === "auth-required" ? (
        <AgentSignIn task={task} pending={pending !== null} onSignIn={(methodId) => onSend("authenticate", { type: "authenticate", methodId })} />
      ) : null}
      {task.state === "failed" ? <AgentFailure task={task} /> : null}
      {task.state !== "closed" && task.state !== "failed" && task.state !== "auth-required" ? (
        <AgentFollowUp task={task} pending={pending === "prompt"} onSend={(text) => onSend("prompt", { type: "prompt", text })} />
      ) : null}
    </div>
  );
}

function AgentPlan({ plan }: { plan: readonly AgentPlanEntry[] }): ReactNode {
  return (
    <details className="agent-plan" open>
      <summary>
        <span>Plan</span>
        <span className="agent-plan__progress">{agentPlanProgress(plan)}</span>
      </summary>
      <ol className="agent-plan__list">
        {plan.map((entry, index) => (
          <li key={index} className={`agent-plan__entry agent-plan__entry--${entry.status}`} data-status={entry.status}>
            <AgentPlanStatusGlyph status={entry.status} />
            <span className="agent-plan__content">{entry.content}</span>
            <span className="visually-hidden">
              {entry.status === "completed" ? "Done" : entry.status === "in_progress" ? "In progress" : "Pending"}
            </span>
            {entry.priority === "high" ? <span className="agent-plan__priority">High</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function emptyTranscriptText(task: AgentSessionTask): string {
  switch (task.state) {
    case "starting": return "Starting the agent and opening a session…";
    case "auth-required": return "The agent needs you to sign in before the session can start.";
    case "failed": return "The agent stopped before it sent any messages.";
    case "closed": return "This session ended without messages.";
    default: return "Waiting for the agent's first message…";
  }
}

/** A cheap fingerprint of the transcript tail; growth or a tail change triggers follow. */
function transcriptSignature(task: AgentSessionTask): string {
  const last = task.entries.at(-1);
  if (!last) return `${task.truncated}:0`;
  const tail = last.kind === "tool"
    ? `${last.status}:${last.output?.length ?? 0}:${last.edits.length}`
    : last.text.length;
  return `${task.truncated}:${task.entries.length}:${last.kind}:${last.id}:${tail}`;
}

function AgentTranscript({ task }: { task: AgentSessionTask }): ReactNode {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [behind, setBehind] = useState(false);
  const signature = transcriptSignature(task);

  // Follow the tail while the reader is at the bottom; otherwise keep their place.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (followRef.current) scroller.scrollTop = scroller.scrollHeight;
    else setBehind(true);
  }, [signature]);

  function scrollToLatest(): void {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    followRef.current = true;
    setBehind(false);
    scroller.scrollTop = scroller.scrollHeight;
  }

  return (
    <div className="agent-transcript-frame">
      <div
        ref={scrollerRef}
        className="agent-transcript"
        role="log"
        aria-label="Agent transcript"
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
          followRef.current = atBottom;
          if (atBottom) setBehind(false);
        }}
      >
        {task.truncated > 0 ? (
          <p className="agent-transcript__truncated">
            {task.truncated === 1 ? "1 earlier entry hidden" : `${task.truncated.toLocaleString()} earlier entries hidden`}
          </p>
        ) : null}
        {task.entries.length === 0 ? (
          <p className="agent-transcript__empty">{emptyTranscriptText(task)}</p>
        ) : task.entries.map((entry) => (
          <AgentEntry key={`${entry.kind}:${entry.id}`} entry={entry} configPath={task.configPath} />
        ))}
      </div>
      {behind ? (
        <button className="button button--secondary button--small agent-transcript__latest" type="button" onClick={scrollToLatest}>
          Latest
        </button>
      ) : null}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 96 ? `${line.slice(0, 95).trimEnd()}…` : line;
}

function AgentEntry({ entry, configPath }: { entry: AgentSessionEntry; configPath: string }): ReactNode {
  switch (entry.kind) {
    case "user": return (
      <div className="agent-entry agent-entry--user">
        <span className="agent-entry__who">You</span>
        <p className="agent-entry__text">{entry.text}</p>
      </div>
    );
    case "agent": return (
      <div className="agent-entry agent-entry--agent">
        <MarkdownLite text={entry.text} />
      </div>
    );
    case "thought": return (
      <details className="agent-entry agent-entry--thought">
        <summary>
          <span className="agent-entry__who">Thinking</span>
          <span className="agent-entry__preview">{firstLine(entry.text)}</span>
        </summary>
        <p className="agent-entry__text">{entry.text}</p>
      </details>
    );
    case "notice": return (
      <p className="agent-entry agent-entry--notice" data-level={entry.level}>
        <AgentNoticeGlyph level={entry.level} />
        <span>{entry.text}</span>
      </p>
    );
    case "tool": return <AgentToolRow entry={entry} configPath={configPath} />;
  }
}

function AgentToolRow({ entry, configPath }: { entry: AgentToolEntry; configPath: string }): ReactNode {
  const edited = new Set(entry.edits.map((edit) => edit.path));
  const locations = entry.locations.filter((location) => !edited.has(location.path));
  return (
    <div className={`agent-entry agent-tool agent-tool--${entry.status}`} data-tool-status={entry.status}>
      <div className="agent-tool__head">
        <AgentToolStatus status={entry.status} />
        <span className="agent-tool__title">{entry.title}</span>
        <span className="agent-tool__kind">{AGENT_TOOL_KIND_LABELS[entry.toolKind]}</span>
      </div>
      {entry.edits.length > 0 || locations.length > 0 ? (
        <ul className="agent-tool__paths" aria-label="Touched files">
          {entry.edits.map((edit) => (
            <li key={`edit:${edit.path}`} title={edit.path}>
              <code>{agentDisplayPath(edit.path, configPath)}</code>
              {" "}<span className="agent-tool__added">+{edit.added}</span>
              {" "}<span className="agent-tool__removed">{"−"}{edit.removed}</span>
            </li>
          ))}
          {locations.map((location, index) => (
            <li key={`location:${index}`} title={location.path}>
              <code>{agentLocationLabel(location, configPath)}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {entry.output ? (
        <details className="agent-tool__output">
          <summary>Output</summary>
          <pre>{entry.output}</pre>
        </details>
      ) : null}
    </div>
  );
}

function permissionTone(option: AgentPermissionOption): string {
  switch (option.kind) {
    case "allow_once": return "button--primary agent-permission__option--allow";
    case "allow_always": return "button--secondary agent-permission__option--allow";
    case "reject_always": return "button--quiet agent-permission__option--reject agent-permission__option--always";
    default: return "button--quiet agent-permission__option--reject";
  }
}

const PERMISSION_KIND_TITLES: Record<AgentPermissionOption["kind"], string> = {
  allow_once: "Allow this request once",
  allow_always: "Allow this kind of request for the rest of the session",
  reject_once: "Reject this request",
  reject_always: "Reject this kind of request for the rest of the session",
};

function AgentPermissionCard({
  permission,
  configPath,
  untrusted,
  pending,
  onAnswer,
}: {
  permission: AgentPermissionRequest;
  configPath: string;
  untrusted: boolean;
  pending: boolean;
  onAnswer(optionId: string | null): void;
}): ReactNode {
  const titleId = useId();
  return (
    <section className="agent-permission" role="group" aria-labelledby={titleId} data-request-id={permission.id}>
      <div className="agent-permission__header">
        <span className="agent-permission__mark"><AgentAttentionGlyph /></span>
        <div className="agent-permission__heading">
          <span className="agent-permission__eyebrow">Permission needed</span>
          <h3 id={titleId}>{permission.title}</h3>
        </div>
        {permission.toolKind ? <span className="agent-tool__kind">{AGENT_TOOL_KIND_LABELS[permission.toolKind]}</span> : null}
      </div>
      {permission.locations.length > 0 ? (
        <ul className="agent-permission__locations" aria-label="Requested files">
          {permission.locations.map((location, index) => (
            <li key={index} title={location.path}><code>{agentLocationLabel(location, configPath)}</code></li>
          ))}
        </ul>
      ) : null}
      {untrusted ? (
        <p className="agent-permission__note">
          This repair runs untrusted: requests outside the dashboard bundle are refused automatically.
        </p>
      ) : null}
      <div className="agent-permission__options">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            className={`button button--small agent-permission__option ${permissionTone(option)}`}
            type="button"
            data-kind={option.kind}
            title={PERMISSION_KIND_TITLES[option.kind]}
            disabled={pending}
            onClick={() => onAnswer(option.optionId)}
          >
            {option.name}
          </button>
        ))}
        <button
          className="button button--quiet button--small agent-permission__dismiss"
          type="button"
          title="Answer without choosing; the agent treats the request as cancelled"
          disabled={pending}
          onClick={() => onAnswer(null)}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

function AgentSignIn({
  task,
  pending,
  onSignIn,
}: {
  task: AgentSessionTask;
  pending: boolean;
  onSignIn(methodId: string): void;
}): ReactNode {
  const titleId = useId();
  const methods = task.auth ?? [];
  return (
    <section className="agent-signin" aria-labelledby={titleId}>
      <div className="agent-permission__header">
        <span className="agent-permission__mark"><AgentLockGlyph /></span>
        <div className="agent-permission__heading">
          <span className="agent-permission__eyebrow">Sign-in required</span>
          <h3 id={titleId}>Sign in to {task.agent.name}</h3>
        </div>
      </div>
      <p>
        The agent needs you to sign in before the session can start. Signing in belongs to the agent;
        dash-bored does not see your credentials.
      </p>
      {methods.length > 0 ? (
        <ul className="agent-signin__methods">
          {methods.map((method) => (
            <li key={method.id}>
              <button className="button button--secondary button--small" type="button" disabled={pending} onClick={() => onSignIn(method.id)}>
                {method.name}
              </button>
              {method.description ? <span>{method.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="agent-signin__none">
          The agent offered no sign-in method. Sign in with the agent's own app, then send the request again.
        </p>
      )}
    </section>
  );
}

function AgentFailure({ task }: { task: AgentSessionTask }): ReactNode {
  return (
    <section className="agent-failure" role="alert">
      <strong>The agent session failed</strong>
      <p>{task.error?.trim() || "The agent process or protocol failed."}</p>
      {task.log.length > 0 ? (
        <>
          <span className="agent-failure__label">
            Agent log · last {task.log.length === 1 ? "line" : `${task.log.length} lines`}
          </span>
          <pre className="agent-failure__log" aria-label="Agent log" tabIndex={0}>{task.log.join("\n")}</pre>
        </>
      ) : null}
    </section>
  );
}

function followUpHint(task: AgentSessionTask): string {
  switch (task.state) {
    case "starting": return "The agent is starting. Follow-ups open when its first turn ends.";
    case "waiting": return "Answer the permission request first.";
    case "working": return "The agent is working. Follow-ups open when its turn ends.";
    default: return "Send a follow-up… (Enter sends, Shift+Enter adds a line)";
  }
}

function AgentFollowUp({
  task,
  pending,
  onSend,
}: {
  task: AgentSessionTask;
  pending: boolean;
  onSend(text: string): Promise<boolean>;
}): ReactNode {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // After a send the field disables until the turn ends; give focus back then.
  const refocusRef = useRef(false);
  const enabled = task.state === "idle" && !pending;
  const canSend = enabled && text.trim() !== "";

  useEffect(() => {
    if (enabled && refocusRef.current) {
      refocusRef.current = false;
      textareaRef.current?.focus();
    }
  }, [enabled]);

  async function submit(): Promise<void> {
    if (!canSend) return;
    refocusRef.current = true;
    if (await onSend(text.trim())) setText("");
  }

  return (
    <form
      className="agent-follow-up"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Follow-up message"
        placeholder={followUpHint(task)}
        rows={2}
        maxLength={MAX_FOLLOW_UP}
        value={text}
        disabled={!enabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit();
        }}
      />
      <button className="button button--primary button--small" type="submit" disabled={!canSend}>
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
