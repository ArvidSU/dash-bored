import { useEffect, useMemo } from "react";
import { activeSelections, agentActionRefusal, suggestActions, unknownActionReason, type AgentViewState } from "../../shared/agent-control";
import type { ResolvedComponentNode } from "../../shared/contracts";
import type { AppView } from "../lib/action-providers";
import { describeAgentAction, type ActionStore } from "../lib/actions";
import { NodeCaptureSession, type NodeCaptureHooks } from "../lib/agent-node-capture";
import { dashboardViewStateStore } from "../lib/dashboard-view-state";
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
  tree: ResolvedComponentNode | null | undefined,
  setActiveView: (view: AppView) => void,
): void {
  const viewRef = useLatestRef(view);
  // A node capture reveals its node through the reveal action, then restores
  // the view and presentation state it found.
  const captureHooksRef = useLatestRef<NodeCaptureHooks>({
    reveal: async (nodeId) => {
      const action = store.get(`reveal:${encodeURIComponent(nodeId)}`);
      if (!action) throw new Error(`No node ${nodeId} in the active dashboard.`);
      const result = await store.run(action.id);
      if (result.status !== "completed") throw new Error(`Could not reveal ${nodeId}.`);
    },
    snapshotView: () => {
      const shown = view.view;
      const presentation = dashboardViewStateStore.getSnapshot(view.configPath, tree);
      return () => {
        setActiveView(shown);
        dashboardViewStateStore.update(view.configPath, tree, () => presentation);
      };
    },
  });
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
