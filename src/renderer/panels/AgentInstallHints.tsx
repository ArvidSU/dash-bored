import type { ReactNode } from "react";
import type { KnownAgent } from "../../shared/agent-session";

/**
 * Where to get known ACP agents that were not found on PATH. The app never
 * installs agents; it only names them and their homepage.
 */
export function AgentInstallHints({
  agents,
  prominent = false,
  summary = "Other agents",
}: {
  agents: readonly KnownAgent[];
  /** Nothing is configured or detected: list the agents openly instead of folding them away. */
  prominent?: boolean;
  summary?: string;
}): ReactNode {
  if (agents.length === 0) return null;
  const list = (
    <ul className="agent-install-hints__list">
      {agents.map((agent) => (
        <li key={agent.id}>
          <a href={agent.homepage} target="_blank" rel="noreferrer" title={agent.homepage}>{agent.name}</a>
          <code>{agent.command}</code>
        </li>
      ))}
    </ul>
  );
  if (prominent) return <div className="agent-install-hints agent-install-hints--prominent">{list}</div>;
  return (
    <details className="agent-install-hints">
      <summary>{summary}</summary>
      <p>Not found on your PATH. Install one, then reopen this picker.</p>
      {list}
    </details>
  );
}
