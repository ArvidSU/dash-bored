import { useCallback, useEffect, useState } from "react";
import type { ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { AgentCommandOptions, AgentSessionTask, AgentTaskCommand } from "../../shared/agent-session";
import { findResolvedNode } from "../../shared/component-agent";
import type { InsertionTarget } from "../composition/dashboard-editor";
import { host } from "../lib/rpc-client";
import type { AgentPromptDraft } from "../panels/AgentPromptPanel";
import type { AppDialog } from "./AppDialogs";
import type { Notices } from "./use-notices";

/** The composer's reviewed draft as a host request; the main process re-checks it. */
function componentAgentRequest(node: ResolvedComponentNode, draft: AgentPromptDraft) {
  return {
    nodeId: node.id,
    prompt: draft.input,
    ...(draft.template ? { template: draft.template } : {}),
    ...(draft.vars ? { vars: draft.vars } : {}),
    ...(draft.agent ? { agent: draft.agent } : {}),
  };
}

export interface AgentWorkOptions {
  notices: Notices;
  /** Whether the Agent work surface is open; host task events also open it. */
  activityOpen: boolean;
  setActivityOpen(open: boolean): void;
  snapshot: ProjectSnapshot | null;
  /** The app-wide agent setting; a change re-resolves the effective agent. */
  appAgentCommand: string | null;
  focusedNodeId: string | undefined;
  setDialog(dialog: AppDialog | null): void;
  /** Building a component with the agent replaces the open draft. */
  endDraft(): void;
  closeLibrary(): void;
}

/**
 * Agent launches and the Agent work surface. Every launch goes through the
 * reviewed prompt composer, and the surface opens so the user sees the run.
 */
export function useAgentWork({
  notices,
  activityOpen,
  setActivityOpen,
  snapshot,
  appAgentCommand,
  focusedNodeId,
  setDialog,
  endDraft,
  closeLibrary,
}: AgentWorkOptions) {
  const { perform, showNotice, setError } = notices;
  const configPath = snapshot?.configPath ?? undefined;
  const revision = snapshot?.revision;
  const [agentOptions, setAgentOptions] = useState<AgentCommandOptions | null>(null);

  // What an omitted choice runs for the active dashboard; the main process
  // resolves it (app setting, bundle .env, then the first detected agent).
  useEffect(() => {
    let active = true;
    if (!configPath) {
      setAgentOptions(null);
      return;
    }
    void host.getAgentOptions(configPath)
      .then((options) => { if (active) setAgentOptions(options); })
      .catch(() => { if (active) setAgentOptions(null); });
    return () => { active = false; };
  }, [appAgentCommand, configPath, revision]);

  function toggleActivity(): void {
    // Render-state based (like the library toggle): the shared drawer also
    // closes on outside pointer-down, which fires before this click handler.
    if (activityOpen) {
      setActivityOpen(false);
      return;
    }
    setActivityOpen(true);
    closeLibrary();
  }

  /** One user command to a session; the host also pushes the updated task. */
  const taskCommand = useCallback(
    (taskId: string, command: AgentTaskCommand): Promise<AgentSessionTask> => host.agentTaskCommand(taskId, command),
    [],
  );

  /** Change with agent briefs the agent with the dashboard template. */
  function openChangeWithAgent(node: ResolvedComponentNode): void {
    setDialog({ kind: "agent", node, draft: { input: "", template: "dashboard" } });
  }

  /** A configured `agent:prompt` invocation; without a caller it targets the focus. */
  function requestPrompt(args: Record<string, unknown>, callerNodeId?: string): void {
    const prompt = args.prompt ?? "";
    const targetId = callerNodeId ?? focusedNodeId ?? snapshot?.tree?.id;
    const target = targetId && snapshot?.tree ? findResolvedNode(snapshot.tree, targetId) : null;
    if (typeof prompt !== "string" || !target) {
      setError("The configured agent prompt target is no longer available.");
      return;
    }
    // Template and vars were validated at load; the main process re-checks them.
    setDialog({
      kind: "agent",
      node: target,
      draft: {
        input: prompt,
        ...(typeof args.template === "string" ? { template: args.template } : {}),
        ...(args.vars !== null && typeof args.vars === "object" && !Array.isArray(args.vars)
          ? { vars: args.vars as Record<string, string | number | boolean> }
          : {}),
      },
    });
  }

  const previewComponentAgent = useCallback(
    (node: ResolvedComponentNode, request: AgentPromptDraft) => host.previewComponentAgent(componentAgentRequest(node, request)),
    [],
  );

  async function runComponentAgent(node: ResolvedComponentNode, request: AgentPromptDraft): Promise<void> {
    await perform(`component-agent:${node.id}`, async () => {
      const launched = await host.launchAgent({ kind: "component", ...componentAgentRequest(node, request) });
      setDialog(null);
      setActivityOpen(true);
      showNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    });
  }

  async function runDiagnosticsAgent(): Promise<void> {
    await perform("diagnostics-agent", async () => {
      const launched = await host.launchAgent({ kind: "diagnostics" });
      setActivityOpen(true);
      showNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    });
  }

  async function runCreationAgent(configPath: string, target: InsertionTarget, prompt: string): Promise<void> {
    await perform("component-agent:create", async () => {
      const launched = await host.launchAgent({ kind: "creation", configPath, target, prompt });
      endDraft();
      setActivityOpen(true);
      showNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    });
  }

  return {
    toggleActivity,
    taskCommand,
    openChangeWithAgent,
    requestPrompt,
    previewComponentAgent,
    runComponentAgent,
    runDiagnosticsAgent,
    runCreationAgent,
    /** The command an omitted choice runs for the active dashboard, or "" when none is available. */
    effectiveAgentCommand: agentOptions?.effective?.command ?? "",
  };
}
