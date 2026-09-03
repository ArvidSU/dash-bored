import { useState } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import { componentPath } from "../../shared/component-agent";
import { errorMessage } from "../app/app-utils";

export function AgentPromptPanel({
  node,
  agentCommand,
  pending,
  onDismiss,
  onSend,
}: {
  node: ResolvedComponentNode;
  agentCommand: string;
  pending: boolean;
  onDismiss: () => void;
  onSend: (prompt: string) => Promise<void>;
}): ReactNode {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const locator = componentPath(node);

  async function submit(): Promise<void> {
    if (!prompt.trim() || pending) return;
    setError(null);
    try {
      await onSend(prompt.trim());
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  }

  return (
    <div className="agent-prompt">
      <p>
        Describe the change to this component. dash-bored adds the owning
        dashboard, component locator, and project instructions to the prompt.
      </p>
      <code className="agent-prompt__path" title={locator}>{locator}</code>
      <form className="agent-prompt__composer" onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
        <code className="agent-prompt__command">{agentCommand}</code>
        <span className="agent-prompt__quote" aria-hidden="true">&quot;</span>
        <textarea
          data-modal-autofocus
          aria-label="Wanted component change"
          placeholder="Change this component…"
          maxLength={12_000}
          value={prompt}
          disabled={pending}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <span className="agent-prompt__quote" aria-hidden="true">&quot;</span>
        <button className="button button--primary" type="submit" disabled={pending || !prompt.trim()}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
      <p className="agent-prompt__hint">Press Command/Ctrl-Enter to send.</p>
      {error ? <div className="agent-prompt__error" role="alert">{error}</div> : null}
      <footer className="editor-modal__actions">
        <button className="button button--quiet" type="button" disabled={pending} onClick={onDismiss}>Cancel</button>
      </footer>
    </div>
  );
}
