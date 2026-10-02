import { resolve } from "node:path";
import { Utils, type BrowserWindow } from "electrobun/main";
import { CoreError, type ProjectRuntime } from "../core/index";
import { agentProcessInfo, agentProcessLogs, type AgentProcessInfo } from "../shared/agent-control";
import { findResolvedNode } from "../shared/component-agent";
import type { ProcessSnapshot } from "../shared/contracts";
import type { DashboardRPC } from "../shared/rpc";
import type { AgentControlBridge } from "./agent-control-server";
import { captureWindowPng, keepWindowRenderingWhenOccluded } from "./window-capture";

type RendererRequests = {
  [K in keyof DashboardRPC["webview"]["requests"]]: (
    params: DashboardRPC["webview"]["requests"][K]["params"],
  ) => Promise<DashboardRPC["webview"]["requests"][K]["response"]>;
};

/** The agent-control channel's view of the app: the renderer for UI, main for processes. */
export function windowAgentControlBridge(
  window: () => BrowserWindow | null,
  runtime: ProjectRuntime,
): AgentControlBridge {
  const requireWindow = (): BrowserWindow => {
    const current = window();
    if (!current) throw new CoreError("APP_WINDOW_UNAVAILABLE", "The dash-bored window is not available.");
    return current;
  };
  const renderer = (): RendererRequests => {
    const request = (window()?.webview.rpc as { request?: RendererRequests } | undefined)?.request;
    if (!request) throw new CoreError("APP_WINDOW_UNAVAILABLE", "The dash-bored window is not available.");
    return request;
  };
  /** Declared command processes with their node labels; ids are node ids. */
  const processes = (): { info: AgentProcessInfo; snapshot: ProcessSnapshot }[] => {
    const { processes: snapshots, tree } = runtime.getSnapshot();
    return snapshots.map((snapshot) => {
      const props = (tree ? findResolvedNode(tree, snapshot.id)?.props : undefined) ?? {};
      const label = props.label ?? props.title;
      return { snapshot, info: agentProcessInfo(snapshot, typeof label === "string" && label !== "" ? label : snapshot.id) };
    });
  };

  return {
    viewState: () => renderer().agentViewState({}),
    listActions: () => renderer().agentListActions({}),
    runAction: (request) => renderer().agentRunAction(request),
    settle: async () => {
      // A relaunch behind other windows starts covered; re-assert before each wait.
      const current = window();
      if (current) keepWindowRenderingWhenOccluded(current.ptr);
      await renderer().agentSettle({});
    },
    idle: async (timeoutMs) => (await renderer().agentIdle({ timeoutMs })).idle,
    capture: () => {
      const current = requireWindow();
      return captureWindowPng({ windowPointer: current.ptr, frame: current.getFrame() }, Utils.screenCapture);
    },
    processes: () => processes().map(({ info }) => info),
    processLogs: (id, tail) => {
      const found = processes().find(({ info }) => info.id === id);
      return found ? agentProcessLogs(found.info, found.snapshot, tail) : null;
    },
    beginNodeCapture: (nodeId) => renderer().agentBeginNodeCapture({ nodeId }),
    endNodeCapture: async () => (await renderer().agentEndNodeCapture({})).stable,
    readNode: (nodeId, timeoutMs) => renderer().agentReadNode({ nodeId, timeoutMs }),
    openDashboard: async (configPath) => {
      // Loading registers the dashboard through onSnapshot, as an app launch for
      // that path did before; trust remains a separate user decision.
      await runtime.load(resolve(configPath), { inputKind: "auto" });
      runtime.watch();
    },
  };
}
