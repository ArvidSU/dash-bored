import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import { childNodes } from "../lib/component-children";
import { nodeLabel } from "../lib/virtual-root";

export type DashboardOutlineNodeAction =
  | "focus"
  | "edit"
  | "collapse"
  | "copy"
  | "agent";

const OUTLINE_MENU_HEIGHT = 208;

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const nodeButtonRef = useRef<HTMLButtonElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const currentVirtualRoot = node.id === currentVirtualRootId;
  const componentCollapsed = collapsedNodeIds.has(node.id);

  function positionMenu(anchorX: number, anchorY: number): void {
    const width = Math.min(224, window.innerWidth - 24);
    setMenuPosition({
      left: Math.max(12, Math.min(anchorX, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(anchorY, window.innerHeight - OUTLINE_MENU_HEIGHT - 12)),
    });
  }

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menuPopoverRef.current?.contains(target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      requestAnimationFrame(() => nodeButtonRef.current?.focus());
    };
    const closeOnViewportChange = (): void => setMenuOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    requestAnimationFrame(() => {
      menuPopoverRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [menuOpen]);

  function choose(action: DashboardOutlineNodeAction): void {
    setMenuOpen(false);
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
            positionMenu(event.clientX, event.clientY);
            setMenuOpen(true);
          }}
        >
          <span className="sidebar-tree__node-label">{label}</span>
          {currentVirtualRoot ? <span className="sidebar-tree__node-state">Current view</span> : null}
        </button>
      </div>
      {menuOpen && typeof document !== "undefined" ? createPortal(
        <div
          className="component-node__menu-popover"
          ref={menuPopoverRef}
          role="menu"
          aria-label={`${label} component actions`}
          style={menuPosition}
        >
          <button
            type="button"
            role="menuitem"
            disabled={currentVirtualRoot}
            title={currentVirtualRoot ? "This component is already focused." : undefined}
            onClick={() => choose("focus")}
          >
            <span>Focus component</span>
            {currentVirtualRoot ? <small>Focused</small> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!active}
            title={!active ? "Open this dashboard before editing its component." : undefined}
            onClick={() => choose("edit")}
          >
            Edit component
          </button>
          <button
            type="button"
            role="menuitem"
            aria-expanded={active ? !componentCollapsed : undefined}
            disabled={!active}
            title={!active ? "Open this dashboard before changing its presentation." : undefined}
            onClick={() => choose("collapse")}
          >
            <span>{componentCollapsed ? "Expand component" : "Collapse component"}</span>
            {componentCollapsed ? <small>Collapsed</small> : null}
          </button>
          <button type="button" role="menuitem" onClick={() => choose("copy")}>
            Copy component path
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!active}
            title={!active ? "Open this dashboard before asking the agent to change its component." : undefined}
            onClick={() => choose("agent")}
          >
            Change with agent…
          </button>
        </div>,
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
