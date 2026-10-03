import type { CSSProperties, ReactNode, Ref } from "react";

export type ComponentActionsMenuAction = "focus" | "edit" | "collapse" | "copy" | "agent" | "move-previous" | "move-next";

export interface ComponentActionsMenuProps {
  label: string;
  focused: boolean;
  collapsed: boolean;
  active?: boolean;
  canMovePrevious?: boolean;
  canMoveNext?: boolean;
  popoverRef: Ref<HTMLDivElement>;
  style: CSSProperties;
  onAction: (action: ComponentActionsMenuAction) => void;
}

export function ComponentActionsMenu({
  label,
  focused,
  collapsed,
  active = true,
  canMovePrevious = false,
  canMoveNext = false,
  popoverRef,
  style,
  onAction,
}: ComponentActionsMenuProps): ReactNode {
  const inactiveTitles = active ? undefined : {
    edit: "Open this dashboard before editing its component.",
    collapse: "Open this dashboard before changing its presentation.",
    agent: "Open this dashboard before asking the agent to change its component.",
  };
  return (
    <div
      className="component-node__menu-popover"
      ref={popoverRef}
      role="menu"
      aria-label={`${label} component actions`}
      style={style}
    >
      <button type="button" role="menuitem" disabled={focused} title={focused ? "This component is already focused." : undefined} onClick={() => onAction("focus")}>
        <span>Focus component</span>
        {focused ? <small>Focused</small> : null}
      </button>
      <button type="button" role="menuitem" disabled={!active} title={inactiveTitles?.edit} onClick={() => onAction("edit")}>Edit component</button>
      <button type="button" role="menuitem" disabled={!active || !canMovePrevious} onClick={() => onAction("move-previous")}>Move component up</button>
      <button type="button" role="menuitem" disabled={!active || !canMoveNext} onClick={() => onAction("move-next")}>Move component down</button>
      <button
        type="button"
        role="menuitem"
        aria-expanded={active ? !collapsed : undefined}
        disabled={!active}
        title={inactiveTitles?.collapse}
        onClick={() => onAction("collapse")}
      >
        <span>{collapsed ? "Expand component" : "Collapse component"}</span>
        {collapsed ? <small>Collapsed</small> : null}
      </button>
      <button type="button" role="menuitem" onClick={() => onAction("copy")}>
        Copy component path
      </button>
      <button type="button" role="menuitem" disabled={!active} title={inactiveTitles?.agent} onClick={() => onAction("agent")}>Change with agent…</button>
    </div>
  );
}
