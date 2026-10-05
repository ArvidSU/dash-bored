import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { DashboardAgentTask, ProcessSnapshot } from "../../shared/contracts";
import { EditorModal } from "../lib/editor-modal";
import { RightDrawer } from "../lib/right-drawer";
import "./agent-terminal.css";
import { TerminalSurface } from "../render/TerminalSurface";
import { writeClipboardText } from "../lib/clipboard";
import { isProcessLive, isProcessRunActive, processRun, processRunOutcome } from "../../shared/process-state";

type AgentModalTab = "terminal" | "diff" | "command";
const AGENT_MODAL_TABS: readonly AgentModalTab[] = ["terminal", "diff", "command"];

function taskSummary(task: DashboardAgentTask): string {
  const request = task.request.trim().replace(/\s+/g, " ");
  const sentence = request.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? request;
  return sentence.length > 160 ? `${sentence.slice(0, 159).trimEnd()}…` : sentence || "Dashboard agent";
}

function agentCommandText(task: DashboardAgentTask): string {
  const command = task.command.trim();
  // Fall back to the visible request when a renderer reload meets a task
  // created by an older still-running desktop host.
  const prompt = task.prompt?.trim() || task.request.trim();
  if (!prompt) return command;
  return `${command} '${prompt.replaceAll("'", "'\\''")}'`;
}

function startedTime(task: DashboardAgentTask): string | null {
  if (!task.startedAt) return null;
  const date = new Date(task.startedAt);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunning(task: DashboardAgentTask): boolean {
  return isProcessRunActive(task.process);
}

function validationLabel(task: DashboardAgentTask): string | null {
  switch (task.validation?.status) {
    case "checking": return "Checking dashboard";
    case "repairing": return "Repairing dashboard";
    case "valid": return "Dashboard validated";
    case "failed": return "Setup needs attention";
    case "trust-required": return "Review project trust";
    case "cancelled": return "Follow-up cancelled";
    default: return null;
  }
}

export function activeDashboardAgentTaskCount(tasks: readonly DashboardAgentTask[]): number {
  return tasks.filter(isRunning).length;
}

export function AgentActivity({
  open,
  tasks,
  onClose,
  onDiff,
  onStop,
  onWrite,
  onResize,
}: {
  open: boolean;
  tasks: readonly DashboardAgentTask[];
  onClose(): void;
  onDiff(taskId: string): Promise<string>;
  onStop(taskId: string): Promise<ProcessSnapshot>;
  onWrite(taskId: string, input: string): Promise<ProcessSnapshot>;
  onResize(taskId: string, cols: number, rows: number): Promise<ProcessSnapshot>;
}): ReactNode {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [scrollToLatest, setScrollToLatest] = useState(0);
  const [activeTab, setActiveTab] = useState<AgentModalTab>("terminal");
  const [diffState, setDiffState] = useState<{
    taskId: string | null;
    loading: boolean;
    value: string;
    error: string | null;
  }>({ taskId: null, loading: false, value: "", error: null });
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const diffRequestRef = useRef(0);
  const tabsId = useId().replaceAll(":", "");
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedRun = processRun(selectedTask?.process);

  useEffect(() => {
    if (!open) {
      setSelectedTaskId(null);
      setActiveTab("terminal");
    }
  }, [open]);

  function selectTask(taskId: string): void {
    setSelectedTaskId(taskId);
    setActiveTab("terminal");
    setDiffState({ taskId: null, loading: false, value: "", error: null });
    setCopiedTaskId(null);
    setCopyError(null);
  }

  function selectTab(tab: AgentModalTab): void {
    setActiveTab(tab);
    if (tab !== "diff" || !selectedTask) return;
    const taskId = selectedTask.id;
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    setDiffState({ taskId, loading: true, value: "", error: null });
    void onDiff(taskId).then((value) => {
      if (diffRequestRef.current !== requestId) return;
      setDiffState({ taskId, loading: false, value, error: null });
    }).catch((error: unknown) => {
      if (diffRequestRef.current !== requestId) return;
      setDiffState({ taskId, loading: false, value: "", error: errorMessage(error) });
    });
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
    selectTab(nextTab);
    document.getElementById(`${tabsId}-${nextTab}-tab`)?.focus();
  }

  async function copyCommand(): Promise<void> {
    if (!selectedTask) return;
    setCopyError(null);
    try {
      await writeClipboardText(agentCommandText(selectedTask));
      setCopiedTaskId(selectedTask.id);
    } catch (error) {
      setCopyError(errorMessage(error));
    }
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
        onClick={() => selectTab(tab)}
        onKeyDown={(event) => selectTabFromKeyboard(event, tab)}
      >
        {label}
      </button>
    );
  }

  return (
    <>
      <RightDrawer
        open={open}
        onClose={onClose}
        title="Agent work"
        eyebrow="Dashboard agent activity"
        description="Tracks configured dashboard-agent CLI work. It does not host or direct the agent."
        closeLabel="Close"
        restoreFocusSelector=".agent-activity-trigger"
      >
        {tasks.length === 0 ? (
          <p className="agent-activity__empty">Agent requests you send from the dashboard appear here.</p>
        ) : (
          <ol className="agent-activity__list">
            {tasks.map((task) => {
              const working = isRunning(task);
              return (
                <li key={task.id}>
                  <button
                    className="agent-task"
                    type="button"
                    aria-label={`${working ? "Working" : "Not working"}: ${taskSummary(task)}`}
                    onClick={() => selectTask(task.id)}
                  >
                    <span className="agent-task__heading">
                      <strong>{taskSummary(task)}</strong>
                      {startedTime(task) ? <time dateTime={task.startedAt}>{startedTime(task)}</time> : null}
                    </span>
                    <span className="agent-task__status">
                      <span className={`phase phase--${working ? "running" : "exited"}`}>
                        {working ? "Working" : "Not working"}
                      </span>
                      {validationLabel(task) ? <span>{validationLabel(task)}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </RightDrawer>
      {open && selectedTask ? (
        <EditorModal title="Agent command" className="editor-modal__panel--wide agent-task-dialog" onDismiss={() => setSelectedTaskId(null)}>
          <div className="agent-task-modal">
            <p className="agent-task-modal__request" title="The Command tab contains the full command and prompt.">{taskSummary(selectedTask)}</p>
            <code className="agent-task-modal__path" title={selectedTask.componentPath}>{selectedTask.componentPath}</code>
            {selectedTask.validation ? (
              <div className="agent-task-modal__feedback" role="status">
                <strong>{validationLabel(selectedTask)}</strong>
                {selectedTask.validation.message ? <p>{selectedTask.validation.message}</p> : null}
                {selectedTask.validation.status === "checking" && !selectedTask.cancelled ? (
                  <button className="button button--quiet" type="button" onClick={() => void onStop(selectedTask.id)}>
                    Cancel automatic follow-up
                  </button>
                ) : null}
                {selectedTask.validation.diagnostics.length > 0 ? (
                  <ul>{selectedTask.validation.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}>{item.code}: {item.message}</li>)}</ul>
                ) : null}
              </div>
            ) : null}
            <div className="agent-task-modal__tabs" role="tablist" aria-label="Agent task details">
              {tabButton("terminal", "Terminal")}
              {tabButton("diff", "Diff")}
              {tabButton("command", "Command")}
            </div>
            <div
              className="agent-task-modal__panel"
              id={`${tabsId}-terminal-panel`}
              role="tabpanel"
              aria-labelledby={`${tabsId}-terminal-tab`}
              hidden={activeTab !== "terminal"}
            >
              {selectedTask ? (
                <div className="command">
                <div className="command__content"><strong>Agent output</strong><code>{selectedTask.command}</code>
                  {selectedRun ? <span className="phase" title="Result of the latest run.">{processRunOutcome(selectedRun)}</span> : null}
                </div><div className="command__actions">
                <button className="button button--quiet" type="button" onClick={() => setScrollToLatest(value => value + 1)}>Latest output</button>
                {isProcessLive(selectedTask.process) ? <button className="button button--quiet" type="button" onClick={() => void onStop(selectedTask.id)}>Close terminal</button> : null}
                </div>
                <TerminalSurface key={selectedTask.id} process={selectedTask.process} scrollToLatest={scrollToLatest}
                  onWrite={isProcessLive(selectedTask.process) ? (input) => onWrite(selectedTask.id, input) : undefined}
                  onResize={isProcessLive(selectedTask.process) ? (cols, rows) => onResize(selectedTask.id, cols, rows) : undefined}
                  label="Interactive terminal for Agent output" />
              </div>
              ) : null}
            </div>
            <div
              className="agent-task-modal__panel"
              id={`${tabsId}-diff-panel`}
              role="tabpanel"
              aria-labelledby={`${tabsId}-diff-tab`}
              hidden={activeTab !== "diff"}
            >
              {diffState.loading ? <p className="editor-muted">{selectedTask?.purpose === "project" ? "Loading project diff…" : "Loading dash-bored diff…"}</p> : null}
              {diffState.error ? <p className="inline-error" role="alert">{diffState.error}</p> : null}
              {!diffState.loading && !diffState.error ? (
                diffState.value ? <pre className="agent-task-modal__diff">{diffState.value}</pre> : <p className="editor-muted">{selectedTask?.purpose === "project" ? "No changes in the project." : "No changes in the dash-bored folder."}</p>
              ) : null}
            </div>
            <div
              className="agent-task-modal__panel"
              id={`${tabsId}-command-panel`}
              role="tabpanel"
              aria-labelledby={`${tabsId}-command-tab`}
              hidden={activeTab !== "command"}
            >
              <div className="agent-task-modal__command-header">
                <strong>Command sent to agent</strong>
                <button className="button button--quiet button--small" type="button" onClick={() => void copyCommand()}>
                  {copiedTaskId === selectedTask.id ? "Copied" : "Copy command"}
                </button>
              </div>
              <pre className="agent-task-modal__command">{agentCommandText(selectedTask)}</pre>
              {copyError ? <p className="inline-error" role="alert">{copyError}</p> : null}
            </div>
          </div>
        </EditorModal>
      ) : null}
    </>
  );
}
