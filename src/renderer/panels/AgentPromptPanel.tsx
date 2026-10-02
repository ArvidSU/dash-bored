import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ComponentAgentPreview, ResolvedComponentNode } from "../../shared/contracts";
import { componentPath } from "../../shared/component-agent";
import { errorMessage } from "../app/app-utils";

/** What the composer opens with: a template, its typed values, and editable input. */
export interface AgentPromptDraft {
  input: string;
  /** Prompt template name; the main process falls back to `project`. */
  template?: string;
  vars?: Record<string, string | number | boolean>;
}

const PREVIEW_DELAY_MS = 200;

export function AgentPromptPanel({
  node,
  agentCommand,
  pending,
  draft,
  onDismiss,
  onPreview,
  onSend,
}: {
  node: ResolvedComponentNode;
  agentCommand: string;
  pending: boolean;
  draft: AgentPromptDraft;
  onDismiss: () => void;
  onPreview: (input: string) => Promise<ComponentAgentPreview>;
  onSend: (input: string) => Promise<void>;
}): ReactNode {
  const [prompt, setPrompt] = useState(draft.input);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ComponentAgentPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const locator = componentPath(node);
  const template = preview?.template;
  const dashboardWork = (template?.scope ?? (draft.template === "dashboard" ? "dashboard" : "project")) === "dashboard";
  const inputOptional = template?.input === "optional";
  const canSend = !pending && previewError === null && (inputOptional || prompt.trim() !== "");

  // The main process renders the prompt from the saved bundle, so the preview
  // is exactly what Send would pass to the agent.
  useEffect(() => {
    const request = previewRequest.current + 1;
    previewRequest.current = request;
    const timer = setTimeout(() => {
      void onPreview(prompt).then((next) => {
        if (previewRequest.current !== request) return;
        setPreview(next);
        setPreviewError(null);
      }, (previewFailure: unknown) => {
        if (previewRequest.current !== request) return;
        setPreviewError(errorMessage(previewFailure));
      });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [prompt, onPreview]);

  async function submit(): Promise<void> {
    if (!canSend) return;
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
        {dashboardWork
          ? "Review the request. dash-bored briefs the agent to change the dashboard from this component, with the owning dashboard, component locator, and project instructions."
          : "Review the request. dash-bored briefs the agent to do work in the project, noting that it was requested from this component."}
      </p>
      <div className="agent-prompt__template">
        <span className="agent-prompt__scope">{dashboardWork ? "Dashboard change" : "Project work"}</span>
        <span>
          Template <code>{template?.name ?? draft.template ?? "project"}</code>
          {template?.description ? ` · ${template.description}` : null}
        </span>
      </div>
      <code className="agent-prompt__path" title={locator}>{locator}</code>
      <form className="agent-prompt__composer" onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
        <code className="agent-prompt__command">{agentCommand}</code>
        <span className="agent-prompt__quote" aria-hidden="true">&quot;</span>
        <textarea
          data-modal-autofocus
          aria-label="Agent prompt"
          placeholder={dashboardWork ? "Describe a dashboard or component change…" : "Describe the work for the agent…"}
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
        <button className="button button--primary" type="submit" disabled={!canSend}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
      <p className="agent-prompt__hint">Press Command/Ctrl-Enter to send.</p>
      <details className="agent-prompt__preview">
        <summary>Full prompt</summary>
        <pre aria-label="Full agent prompt">{preview?.prompt ?? "Rendering…"}</pre>
      </details>
      {previewError ? <div className="agent-prompt__error" role="alert">{previewError}</div> : null}
      {error ? <div className="agent-prompt__error" role="alert">{error}</div> : null}
      <footer className="editor-modal__actions">
        <button className="button button--quiet" type="button" disabled={pending} onClick={onDismiss}>Cancel</button>
      </footer>
    </div>
  );
}
