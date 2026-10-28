import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { AgentSessionTask, AgentTaskCommand } from "../../shared/agent-session";
import { EditorModal } from "../lib/editor-modal";
import { RightDrawer } from "../lib/right-drawer";
import { writeClipboardText } from "../lib/clipboard";
import {
  AGENT_STATE_LABELS,
  agentHandoffApp,
  agentStateTone,
  agentTaskStartedTime,
  agentTaskSummary,
  agentValidationLabel,
  agentValidationTone,
  isAgentSessionOpen,
} from "../lib/agent-tasks";
import { errorMessage } from "../app/app-utils";
import { AgentConfigControl } from "./AgentConfigControl";
import { AgentSession } from "./AgentSession";
import { AgentStateChip, AgentValidationChip } from "./AgentStatus";
import "./agent-work.css";

type AgentModalTab = "session" | "prompt";
const AGENT_MODAL_TABS: readonly AgentModalTab[] = ["session", "prompt"];

export type AgentTaskCommandRunner = (taskId: string, command: AgentTaskCommand) => Promise<AgentSessionTask>;

/** The row's accessible name: state and request, then validation and hand-off. */
function agentTaskRowLabel(task: AgentSessionTask): string {
  const validation = agentValidationLabel(task);
  return [
    `${AGENT_STATE_LABELS[task.state]}: ${agentTaskSummary(task)}`,
    ...(validation ? [validation] : []),
    ...(task.handedOff ? [`Continued in ${agentHandoffApp(task)}`] : []),
  ].join(". ");
}

/**
 * A polite announcement for each new permission request. A task's first
 * appearance (the initial read, or a launch) only records it.
 */
function usePermissionAnnouncement(tasks: readonly AgentSessionTask[]): [string, () => void] {
  const seenRef = useRef(new Map<string, string | null>());
  const [message, setMessage] = useState("");
  useEffect(() => {
    const seen = seenRef.current;
    let next: string | null = null;
    for (const task of tasks) {
      const known = seen.has(task.id);
      const previous = seen.get(task.id);
      const current = task.permission?.id ?? null;
      seen.set(task.id, current);
      if (known && task.permission && current !== previous) {
        next = `${task.agent.name} needs permission: ${task.permission.title}`;
      }
    }
    if (next !== null) setMessage(next);
  }, [tasks]);
  return [message, () => setMessage("")];
}

function Announcement({ message }: { message: string }): ReactNode {
  return <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{message}</p>;
}

/** The Agent work drawer: one row per agent session, and the session modal. */
export function AgentActivity({
  open,
  tasks,
  selectedTaskId,
  onSelectTask,
  onClose,
  onCommand,
}: {
  open: boolean;
  tasks: readonly AgentSessionTask[];
  /** The session whose modal is open; the shell owns it so a notification can open one. */
  selectedTaskId: string | null;
  onSelectTask(taskId: string | null): void;
  onClose(): void;
  onCommand: AgentTaskCommandRunner;
}): ReactNode {
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  // Unsent follow-ups per session; they outlive tab switches and the modal.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [announcement, clearAnnouncement] = usePermissionAnnouncement(tasks);
  const modalOpen = open && selectedTask !== null;

  // The live region moves into the modal while it is open (outside content is
  // hidden from assistive tech then); it starts empty so nothing repeats.
  function selectTask(taskId: string | null): void {
    onSelectTask(taskId);
    clearAnnouncement();
  }

  useEffect(() => {
    if (!open && selectedTaskId !== null) onSelectTask(null);
  }, [onSelectTask, open, selectedTaskId]);

  function setDraft(taskId: string, text: string): void {
    setDrafts((current) => {
      if ((current[taskId] ?? "") === text) return current;
      const next = { ...current };
      if (text) next[taskId] = text;
      else delete next[taskId];
      return next;
    });
  }

  return (
    <>
      <RightDrawer
        open={open}
        onClose={onClose}
        title="Agent work"
        eyebrow="Agent sessions"
        description="Sessions with your ACP agent. Answer its requests, send follow-ups, or resume a session in the agent's own app."
        closeLabel="Close"
        restoreFocusSelector=".agent-activity-trigger"
      >
        {tasks.length === 0 ? (
          <p className="agent-activity__empty">Agent requests you send from the dashboard appear here.</p>
        ) : (
          <ol className="agent-activity__list">
            {tasks.map((task) => {
              const started = agentTaskStartedTime(task);
              return (
                <li key={task.id}>
                  <button
                    className={`agent-task agent-task--${agentStateTone(task.state)}`}
                    type="button"
                    data-task-id={task.id}
                    aria-label={agentTaskRowLabel(task)}
                    onClick={() => selectTask(task.id)}
                  >
                    <span className="agent-task__heading">
                      <strong>{agentTaskSummary(task)}</strong>
                      <span className="agent-task__meta">
                        <span className="agent-task__agent">{task.agent.name}</span>
                        {started ? <time dateTime={task.startedAt}>{started}</time> : null}
                      </span>
                    </span>
                    <span className="agent-task__status">
                      <AgentStateChip state={task.state} />
                      <AgentValidationChip task={task} />
                      {task.handedOff ? <span className="agent-task__handoff">Continued in {agentHandoffApp(task)}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </RightDrawer>
      {modalOpen ? null : <Announcement message={announcement} />}
      {modalOpen ? (
        <EditorModal title="Agent session" className="editor-modal__panel--wide agent-task-dialog" onDismiss={() => selectTask(null)}>
          <Announcement message={announcement} />
          <AgentTaskDetails
            key={selectedTask.id}
            task={selectedTask}
            draft={drafts[selectedTask.id] ?? ""}
            onDraftChange={(text) => setDraft(selectedTask.id, text)}
            onCommand={(command) => onCommand(selectedTask.id, command)}
          />
        </EditorModal>
      ) : null}
    </>
  );
}

function AgentTaskDetails({
  task,
  draft,
  onDraftChange,
  onCommand,
}: {
  task: AgentSessionTask;
  draft: string;
  onDraftChange(text: string): void;
  onCommand(command: AgentTaskCommand): Promise<AgentSessionTask>;
}): ReactNode {
  const [activeTab, setActiveTab] = useState<AgentModalTab>("session");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabsId = useId().replaceAll(":", "");
  const live = isAgentSessionOpen(task.state);
  const started = agentTaskStartedTime(task);
  const validationLabel = agentValidationLabel(task);

  // A pending key disables the controls it covers until the host answers; the
  // answer is in the task list by the time the controls enable again.
  async function send(key: string, command: AgentTaskCommand): Promise<boolean> {
    setPending(key);
    setError(null);
    try {
      await onCommand(command);
      return true;
    } catch (commandError) {
      setError(errorMessage(commandError));
      return false;
    } finally {
      setPending((current) => (current === key ? null : current));
    }
  }

  function selectTabFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, tab: AgentModalTab): void {
    const index = AGENT_MODAL_TABS.indexOf(tab);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % AGENT_MODAL_TABS.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + AGENT_MODAL_TABS.length) % AGENT_MODAL_TABS.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? AGENT_MODAL_TABS.length - 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = AGENT_MODAL_TABS[nextIndex];
    if (!nextTab) return;
    setActiveTab(nextTab);
    document.getElementById(`${tabsId}-${nextTab}-tab`)?.focus();
  }

  function tabButton(tab: AgentModalTab, label: string): ReactNode {
    const selected = activeTab === tab;
    return (
      <button
        className="agent-task-modal__tab"
        id={`${tabsId}-${tab}-tab`}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={`${tabsId}-${tab}-panel`}
        tabIndex={selected ? 0 : -1}
        onClick={() => setActiveTab(tab)}
        onKeyDown={(event) => selectTabFromKeyboard(event, tab)}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="agent-task-modal">
      <div className="agent-task-modal__summary">
        <p className="agent-task-modal__request" title="The Prompt tab contains the full first prompt.">{agentTaskSummary(task)}</p>
        <div className="agent-task-modal__meta">
          <AgentStateChip state={task.state} />
          <span className="agent-task-modal__agent">{task.agent.name}</span>
          {started ? <time dateTime={task.startedAt}>{started}</time> : null}
          <code className="agent-task-modal__path" title={task.componentPath}>{task.componentPath}</code>
        </div>
      </div>

      {task.handedOff ? (
        <p className="agent-task-modal__handed-off" role="status">
          Continued in {agentHandoffApp(task)}. dash-bored no longer drives this session.
        </p>
      ) : task.state !== "closed" && task.state !== "failed" ? (
        <div className="agent-task-modal__controls" role="group" aria-label="Session controls">
          {task.configOptions.length > 0 ? (
            <div className="agent-task-modal__config">
              {task.configOptions.map((option) => (
                <AgentConfigControl
                  key={option.id}
                  option={option}
                  disabled={!live || pending !== null}
                  onChange={(value) => void send(`config:${option.id}`, { type: "config", configId: option.id, value })}
                />
              ))}
            </div>
          ) : null}
          <div className="agent-task-modal__actions">
            {task.state === "working" || task.state === "waiting" ? (
              <button
                className="button button--quiet button--small"
                type="button"
                title="Cancel the agent's current turn; the session stays open"
                disabled={pending !== null}
                onClick={() => void send("cancel", { type: "cancel" })}
              >
                {pending === "cancel" ? "Stopping…" : "Stop"}
              </button>
            ) : null}
            {task.handoff ? (
              <AgentHandoffControl
                task={task}
                handoff={task.handoff}
                pending={pending === "handoff"}
                disabled={pending !== null}
                onHandoff={() => void send("handoff", { type: "handoff" })}
              />
            ) : null}
            <button
              className="button button--quiet button--small agent-task-modal__close-session"
              type="button"
              title="End this session and stop the agent process"
              disabled={pending !== null}
              onClick={() => void send("close", { type: "close" })}
            >
              {pending === "close" ? "Closing…" : "Close session"}
            </button>
          </div>
        </div>
      ) : null}

      {task.validation ? (
        <div className={`agent-task-modal__feedback agent-task-modal__feedback--${agentValidationTone(task)}`} role="status">
          <strong>{validationLabel}</strong>
          {task.validation.message ? <p>{task.validation.message}</p> : null}
          {task.validation.status === "checking" && !task.cancelled ? (
            <button className="button button--quiet button--small" type="button" disabled={pending !== null} onClick={() => void send("cancel", { type: "cancel" })}>
              Cancel automatic follow-up
            </button>
          ) : null}
          {task.validation.diagnostics.length > 0 ? (
            <ul>{task.validation.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}>{item.code}: {item.message}</li>)}</ul>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="inline-error agent-task-modal__error" role="alert">{error}</p> : null}

      <div className="agent-task-modal__tabs" role="tablist" aria-label="Agent session details">
        {tabButton("session", "Session")}
        {tabButton("prompt", "Prompt")}
      </div>
      <div
        className="agent-task-modal__panel"
        id={`${tabsId}-session-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-session-tab`}
        hidden={activeTab !== "session"}
      >
        {activeTab === "session" ? (
          <AgentSession task={task} pending={pending} draft={draft} onDraftChange={onDraftChange} onSend={send} />
        ) : null}
      </div>
      <div
        className="agent-task-modal__panel"
        id={`${tabsId}-prompt-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-prompt-tab`}
        hidden={activeTab !== "prompt"}
      >
        {activeTab === "prompt" ? <AgentPromptDetails task={task} /> : null}
      </div>
    </div>
  );
}

function useCopy(): { copied: string | null; error: string | null; copy(key: string, text: string): Promise<void> } {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return {
    copied,
    error,
    async copy(key, text) {
      setError(null);
      try {
        await writeClipboardText(text);
        setCopied(key);
      } catch (copyError) {
        setCopied(null);
        setError(errorMessage(copyError));
      }
    },
  };
}

function AgentHandoffControl({
  task,
  handoff,
  pending,
  disabled,
  onHandoff,
}: {
  task: AgentSessionTask;
  handoff: NonNullable<AgentSessionTask["handoff"]>;
  pending: boolean;
  disabled: boolean;
  onHandoff(): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const { copied, error, copy } = useCopy();
  const app = agentHandoffApp(task);
  const available = task.state === "idle";

  // The resume command is only offered while hand-off is possible.
  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div
      className="agent-handoff"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // Close the popover only; the session modal stays open.
        event.preventDefault();
        setOpen(false);
        toggleRef.current?.focus();
      }}
    >
      <button
        className="button button--secondary button--small agent-handoff__resume"
        type="button"
        title={available
          ? `Open this session in ${app} in your terminal; dash-bored then lets go of it`
          : `Available when the agent finishes its turn`}
        disabled={disabled || !available}
        onClick={onHandoff}
      >
        {pending ? "Opening…" : `Resume in ${app}`}
      </button>
      {available ? (
        <button
          ref={toggleRef}
          className="button button--quiet button--small agent-handoff__toggle"
          type="button"
          aria-label="Show resume command"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => setOpen((current) => !current)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>
        </button>
      ) : null}
      {open && available ? (
        <div className="agent-handoff__popover" id={popoverId} role="group" aria-label="Resume command">
          <p>Runs from the project root in your terminal:</p>
          <code>{handoff.command}</code>
          <button className="button button--quiet button--small" type="button" onClick={() => void copy("handoff", handoff.command)}>
            {copied === "handoff" ? "Copied" : "Copy command"}
          </button>
          <p className="agent-handoff__hint">dash-bored closes its session when you resume in {app}.</p>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function AgentPromptDetails({ task }: { task: AgentSessionTask }): ReactNode {
  const { copied, error, copy } = useCopy();
  return (
    <div className="agent-task-modal__prompt">
      <div className="agent-task-modal__copy-row">
        <strong>Launch command</strong>
        <button className="button button--quiet button--small" type="button" onClick={() => void copy("command", task.agent.command)}>
          {copied === "command" ? "Copied" : "Copy command"}
        </button>
      </div>
      <code className="agent-task-modal__launch" aria-label="Agent launch command">{task.agent.command}</code>
      <div className="agent-task-modal__copy-row">
        <strong>First prompt</strong>
        <button className="button button--quiet button--small" type="button" onClick={() => void copy("prompt", task.prompt)}>
          {copied === "prompt" ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <pre className="agent-task-modal__prompt-text" aria-label="First prompt" tabIndex={0}>{task.prompt}</pre>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
