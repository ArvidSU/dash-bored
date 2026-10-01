import { createPortal } from "react-dom";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import { ComponentActionsMenu, type ComponentActionsMenuAction } from "../lib/component-actions-menu";
import { childNodes } from "../lib/component-children";
import { useAnchoredMenu } from "../lib/use-anchored-menu";
import { nodeLabel } from "../lib/virtual-root";

export type DashboardOutlineNodeAction = ComponentActionsMenuAction;

interface OutlineBranchProps {
  node: ResolvedComponentNode;
  root?: boolean;
  currentVirtualRootId: string | null;
  active: boolean;
  collapsedNodeIds: ReadonlySet<string>;
  onSelect: (nodeId: string) => void;
  onAction: (node: ResolvedComponentNode, action: DashboardOutlineNodeAction) => void;
}

function OutlineBranch({
  node,
  root = false,
  currentVirtualRootId,
  active,
  collapsedNodeIds,
  onSelect,
  onAction,
}: OutlineBranchProps): ReactNode {
  const children = childNodes(node);
  const label = nodeLabel(node, root);
  const [collapsed, setCollapsed] = useState(false);
  const {
    open: menuOpen,
    position: menuPosition,
    triggerRef: nodeButtonRef,
    popoverRef: menuPopoverRef,
    openAt,
    close: closeMenu,
  } = useAnchoredMenu();
  const currentVirtualRoot = node.id === currentVirtualRootId;
  const componentCollapsed = collapsedNodeIds.has(node.id);

  function choose(action: DashboardOutlineNodeAction): void {
    closeMenu();
    onAction(node, action);
  }

  return (
    <li
      className="sidebar-tree__item"
      role="treeitem"
      aria-expanded={children.length ? !collapsed : undefined}
    >
      <div className="sidebar-tree__row">
        {children.length ? (
          <button
            className="sidebar-tree__collapse"
            type="button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
            aria-expanded={!collapsed}
            title={`${collapsed ? "Expand" : "Collapse"} ${label}`}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span className="sidebar-tree__marker sidebar-tree__marker--branch" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d={collapsed ? "m6 3.5 4.5 4.5L6 12.5" : "m3.5 6 4.5 4.5L12.5 6"} />
              </svg>
            </span>
          </button>
        ) : (
          <span className="sidebar-tree__marker" aria-hidden="true">·</span>
        )}
        <button
          className={`sidebar-tree__node${currentVirtualRoot ? " sidebar-tree__node--virtual-root" : ""}`}
          type="button"
          ref={nodeButtonRef}
          aria-current={currentVirtualRoot ? "location" : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={`Focus ${label} (${node.component})`}
          onClick={() => onSelect(node.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openAt(event.clientX, event.clientY);
          }}
        >
          <span className="sidebar-tree__node-label">{label}</span>
          {currentVirtualRoot ? <span className="sidebar-tree__node-state">Current view</span> : null}
        </button>
      </div>
      {menuOpen && typeof document !== "undefined" ? createPortal(
        <ComponentActionsMenu
          popoverRef={menuPopoverRef}
          style={menuPosition}
          label={label}
          focused={currentVirtualRoot}
          collapsed={componentCollapsed}
          active={active}
          onAction={choose}
        />,
        document.body,
      ) : null}
      {children.length && !collapsed ? (
        <ul className="sidebar-tree__group" role="group">
          {children.map((child) => (
            <OutlineBranch
              key={child.id}
              node={child}
              currentVirtualRootId={currentVirtualRootId}
              active={active}
              collapsedNodeIds={collapsedNodeIds}
              onSelect={onSelect}
              onAction={onAction}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface DashboardOutlineTreeProps {
  tree: ResolvedComponentNode | null;
  loading: boolean;
  error: string | null;
  label: string;
  currentVirtualRootId?: string | null;
  active?: boolean;
  collapsedNodeIds?: ReadonlySet<string>;
  onSelect: (nodeId: string) => void;
  onAction?: (node: ResolvedComponentNode, action: DashboardOutlineNodeAction) => void;
}

export function DashboardOutlineTree({
  tree,
  loading,
  error,
  label,
  currentVirtualRootId = null,
  active = true,
  collapsedNodeIds = new Set<string>(),
  onSelect,
  onAction = () => undefined,
}: DashboardOutlineTreeProps): ReactNode {
  const labelId = useId();
  return (
    <div className="sidebar-tree" aria-live="polite">
      <span className="visually-hidden" id={labelId}>{label} nodes</span>
      {loading ? <span className="sidebar-tree__state">Loading tree…</span> : null}
      {!loading && error ? <span className="sidebar-tree__state sidebar-tree__state--error">{error}</span> : null}
      {!loading && !error && tree ? (
        <ul className="sidebar-tree__root" role="tree" aria-labelledby={labelId}>
          <OutlineBranch
            node={tree}
            root
            currentVirtualRootId={currentVirtualRootId}
            active={active}
            collapsedNodeIds={collapsedNodeIds}
            onSelect={onSelect}
            onAction={onAction}
          />
        </ul>
      ) : null}
    </div>
  );
}
