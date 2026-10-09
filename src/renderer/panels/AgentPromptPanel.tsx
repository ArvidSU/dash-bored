import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentCommandChoice,
  AgentCommandOptions,
  AgentPromptTemplateSummary,
  ComponentAgentPreview,
  ResolvedComponentNode,
} from "../../shared/contracts";
import { componentPath } from "../../shared/component-agent";
import { DEFAULT_PROMPT_TEMPLATE } from "../../shared/prompt-templates";
import { errorMessage } from "../app/app-utils";
import { nodeLabel } from "../lib/virtual-root";

/** What the composer opens with: a template, its typed values, and editable input. */
export interface AgentPromptDraft {
  input: string;
  /** Prompt template name; the main process falls back to `project`. */
  template?: string;
  vars?: Record<string, string | number | boolean>;
  /** Omitted until the user picks; the main process then uses the effective command. */
  agent?: AgentCommandChoice;
}

type PromptVars = Record<string, string | number | boolean>;

const PREVIEW_DELAY_MS = 200;
const MAX_INPUT = 12_000;
const BUILTIN_LABELS: Record<string, string> = {
  dashboard: "Dashboard change",
  project: "Project work",
};

type AgentSource = AgentCommandChoice["source"];

/** Remembered per viewer so a custom command survives reopening the composer. */
const CUSTOM_COMMAND_KEY = "dash-bored.agent-prompt.custom-command";

function storedCustomCommand(): string {
  try {
    return window.localStorage.getItem(CUSTOM_COMMAND_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeCustomCommand(command: string): void {
  try {
    window.localStorage.setItem(CUSTOM_COMMAND_KEY, command);
  } catch {
    // Storage is a convenience; the composer works without it.
  }
}

function commandFor(source: AgentSource, agents: AgentCommandOptions | null, custom: string, fallback: string): string {
  if (source === "custom") return custom.trim();
  if (!agents) return fallback;
  return (source === "project" ? agents.project : agents.app) ?? "";
}

function templateLabel(template: Pick<AgentPromptTemplateSummary, "name" | "builtin">): string {
  return (template.builtin ? BUILTIN_LABELS[template.name] : undefined) ?? template.name;
}

/** Keys the selected template accepts: its declared vars, or whatever the invocation supplied. */
function varKeys(declared: readonly string[] | null, vars: PromptVars): string[] {
  return declared ? [...declared] : Object.keys(vars);
}

/** Only accepted, non-empty values travel; switching templates never sends a foreign var. */
function sentVars(declared: readonly string[] | null, vars: PromptVars): PromptVars | undefined {
  const entries = varKeys(declared, vars)
    .filter((key) => Object.hasOwn(vars, key) && vars[key] !== "")
    .map((key) => [key, vars[key]!] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

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
  onPreview: (request: AgentPromptDraft) => Promise<ComponentAgentPreview>;
  onSend: (request: AgentPromptDraft) => Promise<void>;
}): ReactNode {
  const [prompt, setPrompt] = useState(draft.input);
  const [templateName, setTemplateName] = useState(draft.template ?? DEFAULT_PROMPT_TEMPLATE);
  const [vars, setVars] = useState<PromptVars>(draft.vars ?? {});
  const [tab, setTab] = useState<"request" | "preview">("request");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ComponentAgentPreview | null>(null);
  const [templates, setTemplates] = useState<AgentPromptTemplateSummary[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentCommandOptions | null>(null);
  // `null` follows the effective command until the user picks one.
  const [agentSource, setAgentSource] = useState<AgentSource | null>(draft.agent?.source ?? null);
  const [customCommand, setCustomCommand] = useState(() => (
    draft.agent?.source === "custom" ? draft.agent.command : storedCustomCommand()
  ));
  const previewRequest = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const locator = componentPath(node);
  const name = node.configName?.trim() || node.manifest?.name || nodeLabel(node, false);
  const template = templates.find((candidate) => candidate.name === templateName)
    ?? (preview?.template.name === templateName ? preview.template : undefined);
  const dashboardWork = (template?.scope ?? (templateName === "dashboard" ? "dashboard" : "project")) === "dashboard";
  const inputOptional = template?.input === "optional";
  // Previews refresh the template objects; the request depends only on their declared keys.
  const declaredKey = template?.vars ? Object.keys(template.vars).join("\u0000") : null;
  const declared = useMemo(() => declaredKey?.split("\u0000").filter(Boolean) ?? null, [declaredKey]);
  const keys = varKeys(declared, vars);
  const request = useMemo<AgentPromptDraft>(() => {
    const accepted = sentVars(declared, vars);
    return { input: prompt.trim(), template: templateName, ...(accepted ? { vars: accepted } : {}) };
  }, [prompt, declared, templateName, vars]);
  const shownSource = agentSource ?? agents?.effective ?? "app";
  const shownCommand = commandFor(shownSource, agents, customCommand, agentCommand);
  const agentChoice: AgentCommandChoice | undefined = agentSource === null
    ? undefined
    : agentSource === "custom" ? { source: "custom", command: customCommand.trim() } : { source: agentSource };
  const canSend = !pending
    && previewError === null
    && (inputOptional || prompt.trim() !== "")
    && shownCommand !== "";
  // Until the first preview lists the bundle, the requested template stands alone.
  const options = templates.length > 0
    ? templates
    : [{ name: templateName, builtin: Object.hasOwn(BUILTIN_LABELS, templateName), scope: dashboardWork ? "dashboard" : "project" } as const];

  // The main process renders the prompt from the saved bundle, so the preview
  // is exactly what Send would pass to the agent.
  useEffect(() => {
    const sequence = previewRequest.current + 1;
    previewRequest.current = sequence;
    const timer = setTimeout(() => {
      void onPreview(request).then((next) => {
        if (previewRequest.current !== sequence) return;
        setPreview(next);
        setTemplates(next.templates);
        setAgents(next.agents);
        setPreviewError(null);
      }, (previewFailure: unknown) => {
        if (previewRequest.current !== sequence) return;
        setPreviewError(errorMessage(previewFailure));
      });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [request, onPreview]);

  async function submit(): Promise<void> {
    if (!canSend) return;
    setError(null);
    try {
      if (agentChoice?.source === "custom") storeCustomCommand(agentChoice.command);
      await onSend(agentChoice ? { ...request, agent: agentChoice } : request);
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  }

  function chooseTemplate(next: string): void {
    setTemplateName(next);
    setTab("request");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  return (
    <form
      className="agent-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="agent-prompt__target">
        <span className="agent-prompt__target-mark" aria-hidden="true">
          <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6" /><circle cx="10" cy="10" r="1.6" /><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" /></svg>
        </span>
        <span className="agent-prompt__target-text">
          <strong>{name}</strong>
          {/* RTL keeps the locator's tail visible; the isolate keeps its own order. */}
          <code title={locator}><bdi>{locator}</bdi></code>
        </span>
      </div>

      <fieldset className="agent-prompt__templates" disabled={pending}>
        <legend>Template</legend>
        <div className="agent-prompt__template-list">
          {options.map((option) => (
            <label
              key={option.name}
              className={`agent-prompt__template${option.name === templateName ? " agent-prompt__template--selected" : ""}`}
            >
              <input
                type="radio"
                name={`${id}-template`}
                value={option.name}
                checked={option.name === templateName}
                onChange={() => chooseTemplate(option.name)}
              />
              <span className="agent-prompt__template-name">{templateLabel(option)}</span>
              <span className="agent-prompt__template-meta">
                <span className={`agent-prompt__scope agent-prompt__scope--${option.scope}`}>
                  {option.scope === "dashboard" ? "Dashboard" : "Project"}
                </span>
                {option.builtin ? null : <span>Bundle</span>}
              </span>
            </label>
          ))}
        </div>
        <p className="agent-prompt__template-description">
          {template?.description ?? " "}
        </p>
      </fieldset>

      {keys.length > 0 ? (
        <fieldset className="agent-prompt__vars" disabled={pending}>
          <legend>Values</legend>
          {keys.map((key) => (
            <label key={key} className="agent-prompt__var">
              <span>{key}</span>
              <input
                type="text"
                value={String(vars[key] ?? "")}
                placeholder={template?.vars?.[key] ?? ""}
                onChange={(event) => setVars((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="agent-prompt__editor">
        <div className="agent-prompt__tabs" role="tablist" aria-label="Agent prompt view">
          <button
            type="button"
            role="tab"
            id={`${id}-request-tab`}
            aria-controls={`${id}-request`}
            aria-selected={tab === "request"}
            onClick={() => setTab("request")}
          >
            Request
          </button>
          <button
            type="button"
            role="tab"
            id={`${id}-preview-tab`}
            aria-controls={`${id}-preview`}
            aria-selected={tab === "preview"}
            onClick={() => setTab("preview")}
          >
            Full prompt
          </button>
          <span className="agent-prompt__count" aria-live="off">
            {prompt.length > 0 ? `${prompt.length.toLocaleString()} / ${MAX_INPUT.toLocaleString()}` : null}
          </span>
        </div>
        <div id={`${id}-request`} role="tabpanel" aria-labelledby={`${id}-request-tab`} hidden={tab !== "request"}>
          <textarea
            ref={textareaRef}
            data-modal-autofocus
            aria-label="Agent prompt"
            placeholder={inputOptional
              ? "Optional: add notes for the agent…"
              : dashboardWork
                ? "Describe a dashboard or component change…"
                : "Describe the work for the agent…"}
            maxLength={MAX_INPUT}
            value={prompt}
            disabled={pending}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <div id={`${id}-preview`} role="tabpanel" aria-labelledby={`${id}-preview-tab`} hidden={tab !== "preview"}>
          <pre aria-label="Full agent prompt">{preview?.prompt ?? "Rendering…"}</pre>
        </div>
        <div className="agent-prompt__bar">
          <span className="agent-prompt__runner">
            <span className="agent-prompt__runner-label">via</span>
            <select
              className="agent-prompt__agent-select"
              aria-label="Agent command"
              value={shownSource}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value as AgentSource;
                setAgentSource(next);
                if (next === "custom") requestAnimationFrame(() => customRef.current?.focus());
              }}
            >
              <option value="app">App default</option>
              <option value="project" disabled={agents !== null && agents.project === null}>
                {agents !== null && agents.project === null ? "Project .env (not set)" : "Project .env"}
              </option>
              <option value="custom">Custom</option>
            </select>
            {shownSource === "custom" ? (
              <input
                ref={customRef}
                className="agent-prompt__agent-custom"
                aria-label="Custom agent command"
                placeholder="claude -p"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={1_024}
                value={customCommand}
                disabled={pending}
                onChange={(event) => setCustomCommand(event.target.value)}
              />
            ) : (
              <code title={shownCommand}>{shownCommand}</code>
            )}
          </span>
          <span className="agent-prompt__shortcut" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>
          <button className="button button--quiet" type="button" disabled={pending} onClick={onDismiss}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={!canSend}>
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>

      {previewError ? <div className="agent-prompt__error" role="alert">{previewError}</div> : null}
      {error ? <div className="agent-prompt__error" role="alert">{error}</div> : null}
    </form>
  );
}
