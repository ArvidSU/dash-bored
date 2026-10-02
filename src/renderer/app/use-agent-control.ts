import { useEffect, useMemo } from "react";
import { activeSelections, agentActionRefusal, suggestActions, unknownActionReason, type AgentViewState } from "../../shared/agent-control";
import { describeAgentAction, type ActionStore } from "../lib/actions";
import { NodeCaptureSession, type NodeCaptureHooks } from "../lib/agent-node-capture";
import { registerAgentControlHandler } from "../lib/rpc-client";
import { errorMessage } from "./app-utils";
import { useLatestRef } from "./use-latest-ref";

/**
 * Serves the agent control channel from the window's state: what is shown,
 * the action catalog, node captures, and agent-run actions (minus the ones
 * reserved for the user).
 */
export function useAgentControl(
  store: ActionStore,
  view: Omit<AgentViewState, "selections">,
  captureHooks: NodeCaptureHooks,
): void {
  const viewRef = useLatestRef(view);
  const captureHooksRef = useLatestRef(captureHooks);
  const captureSession = useMemo(() => new NodeCaptureSession(), []);
  useEffect(() => registerAgentControlHandler({
    viewState: () => ({ ...viewRef.current, selections: activeSelections(store.getIndexedActions()) }),
    beginNodeCapture: (nodeId) => captureSession.begin(nodeId, captureHooksRef.current),
    readNode: (nodeId, waitForIdle) => captureSession.read(nodeId, captureHooksRef.current, waitForIdle),
    endNodeCapture: () => captureSession.finish(),
    listActions: () => store.getIndexedActions().map(describeAgentAction),
    async runAction({ reference, selections }) {
      const action = store.get(reference);
      if (!action) {
        // Trust and draft actions are not registered in every state; the
        // agent should still learn that they are the user's to run.
        const reserved = agentActionRefusal({ id: reference });
        if (reserved) return { status: "refused", id: reference, reason: reserved };
        const suggestions = suggestActions(reference, store.getIndexedActions());
        return { status: "unavailable", reason: unknownActionReason(reference, suggestions), suggestions };
      }
      const refusal = agentActionRefusal(action);
      if (refusal) return { status: "refused", id: action.id, reason: refusal };
      const result = await store.run(action.id, selections);
      if (result.status === "completed") {
        return { status: "completed", id: action.id, ...(action.invocationOutcome === "started" ? { process: "started" as const } : {}) };
      }
      if (result.status === "running") return { status: "running", id: action.id, reason: "That action is already running." };
      if (result.status === "unavailable") return { status: "unavailable", id: action.id, reason: result.reason };
      return { status: "failed", id: action.id, reason: errorMessage(result.error) };
    },
  }), [store, captureSession]);
}
