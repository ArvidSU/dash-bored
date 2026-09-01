import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../shared/contracts";
import { childNodes } from "./component-children";
import { nodeLabel } from "./virtual-root";

interface OutlineBranchProps {
  node: ResolvedComponentNode;
  root?: boolean;
  currentVirtualRootId: string | null;
  onSelect: (nodeId: string) => void;
}

function OutlineBranch({
  node,
  root = false,
  currentVirtualRootId,
  onSelect,
}: OutlineBranchProps): ReactNode {
  const children = childNodes(node);
  const label = nodeLabel(node, root);
  const [collapsed, setCollapsed] = useState(false);
  const currentVirtualRoot = node.id === currentVirtualRootId;

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
              {collapsed ? "›" : "⌄"}
            </span>
          </button>
        ) : (
          <span className="sidebar-tree__marker" aria-hidden="true">·</span>
        )}
        <button
          className={`sidebar-tree__node${currentVirtualRoot ? " sidebar-tree__node--virtual-root" : ""}`}
          type="button"
          aria-current={currentVirtualRoot ? "location" : undefined}
          title={`Focus ${label} (${node.component})`}
          onClick={() => onSelect(node.id)}
        >
          <span className="sidebar-tree__node-label">{label}</span>
          {currentVirtualRoot ? <span className="sidebar-tree__node-state">Current view</span> : null}
        </button>
      </div>
      {children.length && !collapsed ? (
        <ul className="sidebar-tree__group" role="group">
          {children.map((child) => (
            <OutlineBranch
              key={child.id}
              node={child}
              currentVirtualRootId={currentVirtualRootId}
              onSelect={onSelect}
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
  onSelect: (nodeId: string) => void;
}

export function DashboardOutlineTree({
  tree,
  loading,
  error,
  label,
  currentVirtualRootId = null,
  onSelect,
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
            onSelect={onSelect}
          />
        </ul>
      ) : null}
    </div>
  );
}
