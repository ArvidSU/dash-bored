import type { ReactNode } from "react";
import type { Diagnostic, ProjectSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import { ComponentVisibilityContext } from "../composition/ComponentCompositor";
import { CompositionContext, type CompositionContextValue } from "../composition/composition-context";
import { Diagnostics } from "../panels/DiagnosticsPanel";
import { TrustPanel } from "../panels/TrustPanel";
import { DashboardRenderContext, NodeRenderer, type DashboardRenderContextValue } from "../render/NodeRenderer";
import type { resolveVirtualRoot } from "../lib/virtual-root";
import { dashboardTitle } from "./app-utils";

export interface DashboardWorkspaceProps {
  snapshot: ProjectSnapshot;
  tree?: ResolvedComponentNode | null;
  draftPreviewUnavailable?: boolean;
  /** The focused target and its breadcrumb path, from the draft preview while composing. */
  virtualRoot: ReturnType<typeof resolveVirtualRoot> | null;
  diagnostics: Diagnostic[];
  pendingAction: string | null;
  /** False while composition UI covers the dashboard, so views can pause work. */
  componentsVisible: boolean;
  composition: CompositionContextValue | null;
  render: Omit<DashboardRenderContextValue, "focusedNodeId">;
  onFocus(nodeId: string): void;
  onTrust(): void;
  onReload(): void;
  onFixWithAgent(): void;
  onRepairInstalledTools(): void;
}

/** The active dashboard: trust and diagnostics above the focused component tree. */
export function DashboardWorkspace({
  snapshot,
  tree: resolvedTree,
  draftPreviewUnavailable = false,
  virtualRoot,
  diagnostics,
  pendingAction,
  componentsVisible,
  composition,
  render,
  onFocus,
  onTrust,
  onReload,
  onFixWithAgent,
  onRepairInstalledTools,
}: DashboardWorkspaceProps): ReactNode {
  const tree: ResolvedComponentNode | null = draftPreviewUnavailable
    ? snapshot.tree
    : resolvedTree === undefined ? snapshot.tree : resolvedTree;
  return (
    <main className="workspace">
      <>
          {draftPreviewUnavailable ? (
            <div className="inline-warning" role="status">The draft has not resolved yet. The saved dashboard remains visible while it is checked.</div>
          ) : null}
          {!snapshot.trusted ? (
            <TrustPanel snapshot={snapshot} pending={pendingAction === "trust"} onTrust={onTrust} />
          ) : null}

          <Diagnostics
            diagnostics={diagnostics}
            pending={pendingAction === "diagnostics-agent"}
            repairPending={pendingAction === "installed-tools-repair"}
            onFixWithAgent={onFixWithAgent}
            onRepairInstalledTools={onRepairInstalledTools}
          />

          {tree ? (
            <section className="dashboard" aria-label={`${dashboardTitle(snapshot)} dashboard`}>
              {virtualRoot && virtualRoot.crumbs.length > 1 ? (
                <nav className="dashboard-breadcrumbs" aria-label="Focused component path">
                  {virtualRoot.crumbs.map((crumb, index) => (
                    <span className="dashboard-breadcrumbs__item" key={crumb.id}>
                      {index < virtualRoot.crumbs.length - 1 ? (
                        <button type="button" onClick={() => onFocus(crumb.id)}>{crumb.label}</button>
                      ) : <span aria-current="page">{crumb.label}</span>}
                      {index < virtualRoot.crumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
                    </span>
                  ))}
                </nav>
              ) : null}
              <ComponentVisibilityContext.Provider value={componentsVisible}>
                <CompositionContext.Provider value={composition}>
                  <DashboardRenderContext.Provider value={{ ...render, focusedNodeId: virtualRoot?.target.id ?? tree.id }}>
                    <NodeRenderer node={virtualRoot?.node ?? tree} />
                  </DashboardRenderContext.Provider>
                </CompositionContext.Provider>
              </ComponentVisibilityContext.Provider>
            </section>
          ) : (
            <section className="empty-dashboard">
              <span className="eyebrow">Configuration unavailable</span>
              <h1>The dashboard could not be rendered.</h1>
              <p>Fix the diagnostics above, then reload the project.</p>
              <button className="button button--secondary" type="button" disabled={pendingAction !== null} onClick={onReload}>Try again</button>
            </section>
          )}
      </>

      <footer className="workspace__footer">
        <span>Revision {snapshot.revision}</span>
        <span>{snapshot.trusted ? "Capabilities enabled" : "Restricted mode"}</span>
      </footer>
    </main>
  );
}
