import { useId } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../shared/contracts";
import { childNodes } from "./component-children";
import { nodeLabel } from "./virtual-root";

interface OutlineBranchProps {
  node: ResolvedComponentNode;
  root?: boolean;
  onSelect: (nodeId: string) => void;
}

function OutlineBranch({ node, root = false, onSelect }: OutlineBranchProps): ReactNode {
  const children = childNodes(node);
  const label = nodeLabel(node, root);
  return (
    <li className="sidebar-tree__item" role="treeitem">
      <button
        className="sidebar-tree__node"
        type="button"
        title={`Focus ${label} (${node.component})`}
        onClick={() => onSelect(node.id)}
      >
        <span className={`sidebar-tree__marker${children.length ? " sidebar-tree__marker--branch" : ""}`} aria-hidden="true">
          {children.length ? "⌄" : "·"}
        </span>
        <span className="sidebar-tree__node-label">{label}</span>
      </button>
      {children.length ? (
        <ul className="sidebar-tree__group" role="group">
          {children.map((child) => (
            <OutlineBranch key={child.id} node={child} onSelect={onSelect} />
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
  onSelect: (nodeId: string) => void;
}

export function DashboardOutlineTree({
  tree,
  loading,
  error,
  label,
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
          <OutlineBranch node={tree} root onSelect={onSelect} />
        </ul>
      ) : null}
    </div>
  );
}
