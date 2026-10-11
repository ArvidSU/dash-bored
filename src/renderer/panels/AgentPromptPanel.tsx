import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentPromptTemplateSummary, ResolvedComponentNode } from "../../shared/contracts";
import type { AgentCommandChoice, AgentCommandOptions, ComponentAgentPreview } from "../../shared/agent-session";
import { componentPath } from "../../shared/component-agent";
import { DEFAULT_PROMPT_TEMPLATE } from "../../shared/prompt-templates";
import { errorMessage } from "../app/app-utils";
import {
  choiceForPickerValue,
  commandForPickerValue,
  detectedPickerValue,
  effectivePickerValue,
  pickerValueForChoice,
  storeCustomAgentCommand,
  storedCustomAgentCommand,
  undetectedKnownAgents,
  type AgentPickerValue,
} from "../lib/agent-options";
import { nodeLabel } from "../lib/virtual-root";
import { AgentInstallHints } from "./AgentInstallHints";

/** What the composer opens with: a template, its typed values, and editable input. */
export interface AgentPromptDraft {
  input: string;
  /** Prompt template name; the main process falls back to `project`. */
  template?: string;
  vars?: Record<string, string | number | boolean>;
  /** Omitted until the user picks; the main process then uses the effective agent. */
  agent?: AgentCommandChoice;
}

type PromptVars = Record<string, string | number | boolean>;

const PREVIEW_DELAY_MS = 200;
const MAX_INPUT = 12_000;
const BUILTIN_LABELS: Record<string, string> = {
  dashboard: "Dashboard change",
  project: "Project work",
};

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

/** One target as the composer names it. */
function targetSummary(node: ResolvedComponentNode) {
  return {
    id: node.id,
    name: node.configName?.trim() || node.manifest?.name || nodeLabel(node, false),
    locator: componentPath(node),
  };
}

export function AgentPromptPanel({
  nodes,
  pending,
  draft,
  onDismiss,
  onPreview,
  onSend,
}: {
  /** Never empty; several when the dropper Shift-selected them, in pick order. */
  nodes: readonly ResolvedComponentNode[];
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
  // `null` follows the effective agent until the user picks one.
  const [agentValue, setAgentValue] = useState<AgentPickerValue | null>(
    draft.agent ? pickerValueForChoice(draft.agent) : null,
  );
  const [customCommand, setCustomCommand] = useState(() => (
    draft.agent?.source === "custom" ? draft.agent.command : storedCustomAgentCommand()
  ));
  const previewRequest = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const targets = nodes.map(targetSummary);
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
  const shownValue = agentValue ?? effectivePickerValue(agents);
  const shownCommand = commandForPickerValue(shownValue, agents, customCommand);
  const agentChoice: AgentCommandChoice | undefined = agentValue === null
    ? undefined
    : choiceForPickerValue(agentValue, customCommand);
  const noAgent = agents !== null && agents.effective === null && agentValue === null;
  const installable = undetectedKnownAgents(agents);
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
      if (agentChoice?.source === "custom") storeCustomAgentCommand(agentChoice.command);
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
        {targets.length === 1 ? (
          <span className="agent-prompt__target-text">
            <strong>{targets[0]!.name}</strong>
            {/* RTL keeps the locator's tail visible; the isolate keeps its own order. */}
            <code title={targets[0]!.locator}><bdi>{targets[0]!.locator}</bdi></code>
          </span>
        ) : (
          <div className="agent-prompt__target-group">
            <strong>{targets.length} components</strong>
            <ol className="agent-prompt__target-list" aria-label="Target components">
              {targets.map((target) => (
                <li key={target.id} className="agent-prompt__target-text agent-prompt__target-text--row">
                  <strong>{target.name}</strong>
                  <code title={target.locator}><bdi>{target.locator}</bdi></code>
                </li>
              ))}
            </ol>
          </div>
        )}
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
              aria-label="Agent"
              value={shownValue ?? ""}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value as AgentPickerValue;
                setAgentValue(next);
                if (next === "custom") requestAnimationFrame(() => customRef.current?.focus());
              }}
            >
              {shownValue === null ? <option value="" disabled>{agents === null ? "Resolving…" : "No agent found"}</option> : null}
              <option value="app" disabled={agents !== null && agents.app === null}>
                {agents !== null && agents.app === null ? "App default (not set)" : "App default"}
              </option>
              <option value="project" disabled={agents !== null && agents.project === null}>
                {agents !== null && agents.project === null ? "Project .env (not set)" : "Project .env"}
              </option>
              {agents && agents.detected.length > 0 ? (
                <optgroup label="Detected on PATH">
                  {agents.detected.map((agent) => (
                    <option key={agent.id} value={detectedPickerValue(agent.id)}>{agent.name}</option>
                  ))}
                </optgroup>
              ) : null}
              <option value="custom">Custom command</option>
            </select>
            {shownValue === "custom" ? (
              <input
                ref={customRef}
                className="agent-prompt__agent-custom"
                aria-label="Custom agent command"
                placeholder="gemini --acp"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={1_024}
                value={customCommand}
                disabled={pending}
                onChange={(event) => setCustomCommand(event.target.value)}
              />
            ) : (
              <code title={shownCommand ? `Runs ${shownCommand}` : undefined} aria-label="Agent launch command">{shownCommand || "—"}</code>
            )}
          </span>
          <span className="agent-prompt__shortcut" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>
          <button className="button button--quiet" type="button" disabled={pending} onClick={onDismiss}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={!canSend}>
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>

      {noAgent ? (
        <div className="agent-prompt__no-agent" role="status">
          <p>
            No ACP agent is configured or detected on your PATH. Install one of these agents, set one in
            Settings, or choose Custom command.
          </p>
          <AgentInstallHints agents={installable} prominent />
        </div>
      ) : agents !== null ? (
        <AgentInstallHints agents={installable} summary="Install another agent" />
      ) : null}
      {previewError ? <div className="agent-prompt__error" role="alert">{previewError}</div> : null}
      {error ? <div className="agent-prompt__error" role="alert">{error}</div> : null}
    </form>
  );
}
