import type { ReactNode } from "react";
import type { DashboardAgentTask } from "../shared/contracts";

function statusLabel(task: DashboardAgentTask): string {
  if (task.process.phase === "running") return task.dashboardChanged ? "Dashboard changed" : "Running";
  if (task.process.phase === "stopping") return "Stopping";
  if (task.process.phase === "failed") return "Failed";
  if (task.process.phase === "exited") {
    if (task.process.exitCode === 0) return "Exited — review changes";
    if (task.process.exitCode !== null) return `Exited with code ${task.process.exitCode}`;
    return task.process.signal ? "Stopped" : "Exited";
  }
  return "Starting";
}

function isRunning(task: DashboardAgentTask): boolean {
  return task.process.phase === "running" || task.process.phase === "stopping";
}

export function activeDashboardAgentTaskCount(tasks: readonly DashboardAgentTask[]): number {
  return tasks.filter(isRunning).length;
}

export function AgentActivity({
  open,
  tasks,
  onClose,
  onStop,
}: {
  open: boolean;
  tasks: readonly DashboardAgentTask[];
  onClose(): void;
  onStop(taskId: string): void;
}): ReactNode {
  if (!open) return null;
  return (
    <aside className="agent-activity" aria-label="Agent work" role="dialog" aria-modal="false">
      <header className="agent-activity__header">
        <div>
          <span className="eyebrow">Dashboard agent activity</span>
          <h2>Agent work</h2>
          <p>Tracks configured dashboard-agent CLI work. It does not host or direct the agent.</p>
        </div>
        <button className="button button--quiet" type="button" onClick={onClose}>Close</button>
      </header>
      {tasks.length === 0 ? (
        <p className="agent-activity__empty">Agent requests you send from the dashboard appear here.</p>
      ) : (
        <ol className="agent-activity__list">
          {tasks.map((task) => {
            const output = task.process.logs.slice(-10).map((entry) => entry.text).join("").trim();
            return (
              <li className="agent-task" key={task.id}>
                <div className="agent-task__heading">
                  <span className={`phase phase--${task.process.phase}`}>{statusLabel(task)}</span>
                  {task.startedAt ? <time dateTime={task.startedAt}>{new Date(task.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}
                </div>
                <p className="agent-task__request">{task.request}</p>
                <code className="agent-task__path" title={task.componentPath}>{task.componentPath}</code>
                <small>{task.command}</small>
                {task.dashboardChanged ? <p className="agent-task__change">Dashboard changed while this agent was running. Review the result.</p> : null}
                {output ? <pre className="agent-task__output">{output}</pre> : null}
                {isRunning(task) ? (
                  <button className="button button--danger button--small" type="button" disabled={task.process.phase === "stopping"} onClick={() => onStop(task.id)}>
                    {task.process.phase === "stopping" ? "Stopping…" : "Stop agent"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
