import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { AgentConfigOption, AgentSessionTask, AgentTaskCommand } from "../../shared/agent-session";
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
import { AgentSession } from "./AgentSession";
import { AgentStateChip, AgentValidationChip } from "./AgentStatus";
import "./agent-work.css";

type AgentModalTab = "session" | "prompt";
const AGENT_MODAL_TABS: readonly AgentModalTab[] = ["session", "prompt"];

export type AgentTaskCommandRunner = (taskId: string, command: AgentTaskCommand) => Promise<AgentSessionTask>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Agent work drawer: one row per agent session, and the session modal. */
export function AgentActivity({
  open,
  tasks,
  onClose,
  onCommand,
}: {
  open: boolean;
  tasks: readonly AgentSessionTask[];
  onClose(): void;
  onCommand: AgentTaskCommandRunner;
}): ReactNode {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  useEffect(() => {
    if (!open) setSelectedTaskId(null);
  }, [open]);

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
                    aria-label={`${AGENT_STATE_LABELS[task.state]}: ${agentTaskSummary(task)}`}
                    onClick={() => setSelectedTaskId(task.id)}
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
      {open && selectedTask ? (
        <EditorModal title="Agent session" className="editor-modal__panel--wide agent-task-dialog" onDismiss={() => setSelectedTaskId(null)}>
          <AgentTaskDetails key={selectedTask.id} task={selectedTask} onCommand={(command) => onCommand(selectedTask.id, command)} />
        </EditorModal>
      ) : null}
    </>
  );
}

function AgentTaskDetails({
  task,
  onCommand,
}: {
  task: AgentSessionTask;
  onCommand(command: AgentTaskCommand): Promise<AgentSessionTask>;
}): ReactNode {
  const [activeTab, setActiveTab] = useState<AgentModalTab>("session");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabsId = useId().replaceAll(":", "");
  const live = isAgentSessionOpen(task.state);
  const started = agentTaskStartedTime(task);
  const validationLabel = agentValidationLabel(task);

  // A pending key disables the controls it covers until the host answers.
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
        <div className="agent-task-modal__controls" role="toolbar" aria-label="Session controls">
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
        {activeTab === "session" ? <AgentSession task={task} pending={pending} onSend={send} /> : null}
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

/** Consecutive options that share a group render as one <optgroup>, in agent order. */
function optionSegments(options: NonNullable<AgentConfigOption["options"]>) {
  const segments: Array<{ group?: string; options: typeof options }> = [];
  for (const option of options) {
    const last = segments.at(-1);
    if (last && last.group === option.group) last.options.push(option);
    else segments.push({ ...(option.group ? { group: option.group } : {}), options: [option] });
  }
  return segments;
}

function AgentConfigControl({
  option,
  disabled,
  onChange,
}: {
  option: AgentConfigOption;
  disabled: boolean;
  onChange(value: string | boolean): void;
}): ReactNode {
  if (option.type === "boolean") {
    return (
      <label className="agent-config agent-config--boolean" title={option.description}>
        <input type="checkbox" checked={option.currentValue === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span>{option.name}</span>
      </label>
    );
  }
  const choices = option.options ?? [];
  const current = String(option.currentValue);
  const known = choices.some((choice) => choice.value === current);
  return (
    <label className="agent-config" title={option.description}>
      <span>{option.name}</span>
      <select value={current} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {known ? null : <option value={current} disabled>{current}</option>}
        {optionSegments(choices).map((segment, index) => {
          const items = segment.options.map((choice) => (
            <option key={choice.value} value={choice.value} title={choice.description}>{choice.name}</option>
          ));
          return segment.group ? <optgroup key={`${segment.group}-${index}`} label={segment.group}>{items}</optgroup> : items;
        })}
      </select>
    </label>
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
      {open ? (
        <div className="agent-handoff__popover" id={popoverId} role="group" aria-label="Resume command">
          <p>Runs from the project root in your terminal:</p>
          <code>{handoff.command}</code>
          <button className="button button--quiet button--small" type="button" onClick={() => void copy("handoff", handoff.command)}>
            {copied === "handoff" ? "Copied" : "Copy command"}
          </button>
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
