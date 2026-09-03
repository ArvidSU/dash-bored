import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { ResolvedComponentNode } from "../../shared/contracts";
import type { NodePath } from "../composition/dashboard-editor";
import { pathEquals } from "../composition/dashboard-editor";
import { countComponentDescendants } from "../lib/component-view-state";
import { MIN_COMPONENT_HEIGHT_PX, normalizeComponentHeight } from "../lib/component-height";
import { nodeLabel } from "../lib/virtual-root";
import { CompositionContext, type CompositionDragPayload, type CompositionDropZone } from "../composition/composition-context";
import { compositionPayloadFromDragEvent } from "../composition/composition-dnd";
import { usePointerSession } from "../lib/pointer-session";
import { compositionPayloadLabel } from "../composition/composition-labels";

export interface ComponentFrameProps {
  as?: "div" | "section";
  node: ResolvedComponentNode;
  className: string;
  isVirtualRoot: boolean;
  collapsed: boolean;
  height?: number;
  heightResizable: boolean;
  role?: "alert";
  ariaLive?: "polite";
  onFocus: (nodeId: string) => void;
  onToggleCollapse: () => void;
  onHeightChange: (height: number | null) => void;
  onCopyPath: (node: ResolvedComponentNode) => void;
  onEditComponent: (node: ResolvedComponentNode) => void;
  onOpenAgent: (node: ResolvedComponentNode) => void;
  children: ReactNode;
}

function canStartCompositionDrag(
  event: ReactPointerEvent<HTMLElement>,
  nodeId: string,
): boolean {
  if (event.button !== 0) return false;
  const target = event.target instanceof globalThis.Element ? event.target : null;
  if (!target) return false;
  // A frame can contain another component frame. Only the nearest frame owns
  // a direct-manipulation gesture, otherwise dragging a nested card would move
  // every ancestor that happens to receive the bubbled pointer event.
  if (target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId !== nodeId) return false;
  // The frame-owned handle is the only direct-manipulation affordance. Keeping
  // it explicit means component content and controls remain ordinary UI.
  return target.closest("[data-composition-drag-handle]") !== null;
}

export function ComponentFrame({
  as = "div",
  node,
  className,
  isVirtualRoot,
  collapsed,
  height,
  heightResizable,
  role,
  ariaLive,
  onFocus,
  onToggleCollapse,
  onHeightChange,
  onCopyPath,
  onEditComponent,
  onOpenAgent,
  children,
}: ComponentFrameProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [transientHeight, setTransientHeight] = useState<number | null | undefined>(undefined);
  const [heightDragging, setHeightDragging] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState(height ?? MIN_COMPONENT_HEIGHT_PX);
  const [intrinsicHeight, setIntrinsicHeight] = useState(height ?? MIN_COMPONENT_HEIGHT_PX);
  const frameRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const heightDragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    maximumHeight: number;
    lastHeight: number | null;
    captureTarget: HTMLElement;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const clickTimerRef = useRef<number | null>(null);
  const composition = useContext(CompositionContext);
  const compositionRef = useRef(composition);
  const pointerMoveRef = useRef<{
    pointerId: number;
    path: NodePath;
    startX: number;
    startY: number;
    active: boolean;
    captureTarget: HTMLElement;
  } | null>(null);
  const compositionPointerSession = usePointerSession();
  const heightPointerSession = usePointerSession();
  compositionRef.current = composition;
  const Element = as;
  const name = node.configName?.trim() || nodeLabel(node, false);
  const descendantCount = countComponentDescendants(node);
  const compositionPath = composition?.active ? composition.pathForNode(node) : null;
  const compositionDragActive = composition !== null && composition.dragging !== null;
  const compositionDragSource = composition?.dragging?.type === "node"
    && compositionPath !== null
    && pathEquals(compositionPath, composition.dragging.path);
  const compositionDragLabel = composition?.dragging
    ? compositionPayloadLabel(composition.dragging, composition.config, composition.catalog)
    : null;
  const showComponentMenu = !compositionDragActive;
  const savedHeight = normalizeComponentHeight(height) ?? null;
  const effectiveHeight = transientHeight === undefined ? savedHeight : transientHeight;
  const heightCapped = heightResizable && !collapsed && effectiveHeight !== null;
  const frameStyle = heightCapped
    ? { "--component-max-height": `${effectiveHeight}px` } as CSSProperties
    : undefined;

  function measureIntrinsicHeight(): number {
    const frame = frameRef.current;
    const viewport = viewportRef.current;
    const frameHeight = frame?.getBoundingClientRect().height ?? MIN_COMPONENT_HEIGHT_PX;
    const surface = [...(viewport?.children ?? [])].find((candidate) => (
      candidate instanceof HTMLElement
      && !candidate.classList.contains("component-node__update-polish")
      && !candidate.classList.contains("component-node__stale-warning")
    )) as HTMLElement | undefined;
    if (!surface) return Math.max(MIN_COMPONENT_HEIGHT_PX, Math.round(frameHeight));
    const styles = window.getComputedStyle(surface);
    const borderHeight = (Number.parseFloat(styles.borderTopWidth) || 0)
      + (Number.parseFloat(styles.borderBottomWidth) || 0);
    return Math.max(
      MIN_COMPONENT_HEIGHT_PX,
      Math.round(frameHeight),
      Math.ceil(surface.scrollHeight + borderHeight),
    );
  }

  function requestedComponentHeight(
    startHeight: number,
    startY: number,
    clientY: number,
    maximumHeight: number,
  ): number | null {
    const minimumHeight = Math.min(MIN_COMPONENT_HEIGHT_PX, maximumHeight);
    const requested = Math.max(minimumHeight, Math.min(maximumHeight, startHeight + clientY - startY));
    return requested >= maximumHeight - 1 ? null : Math.round(requested);
  }

  function finishHeightDrag(
    pointerId: number,
    clientY: number | null,
    commit: boolean,
    useLastHeight = false,
  ): void {
    const current = heightDragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const next = commit
      ? (useLastHeight ? current.lastHeight : requestedComponentHeight(
          current.startHeight,
          current.startY,
          clientY ?? current.startY,
          current.maximumHeight,
        ))
      : current.lastHeight;
    heightDragRef.current = null;
    if (current.captureTarget.hasPointerCapture(pointerId)) {
      current.captureTarget.releasePointerCapture(pointerId);
    }
    setHeightDragging(false);
    setTransientHeight(commit ? next : undefined);
    if (commit) onHeightChange(next);
  }

  function setHeightFromKeyboard(delta: number | "minimum" | "full"): void {
    const maximumHeight = measureIntrinsicHeight();
    setIntrinsicHeight(maximumHeight);
    if (delta === "full") {
      setTransientHeight(null);
      onHeightChange(null);
      return;
    }
    const currentHeight = frameRef.current?.getBoundingClientRect().height ?? maximumHeight;
    const requested = delta === "minimum"
      ? Math.min(MIN_COMPONENT_HEIGHT_PX, maximumHeight)
      : currentHeight + delta;
    const next = Math.max(Math.min(MIN_COMPONENT_HEIGHT_PX, maximumHeight), Math.min(maximumHeight, requested));
    const nextHeight = next >= maximumHeight - 1 ? null : Math.round(next);
    setTransientHeight(nextHeight);
    onHeightChange(nextHeight);
  }

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || !heightResizable || collapsed) return;
    const update = (): void => {
      const current = Math.round(frame.getBoundingClientRect().height);
      setMeasuredHeight(current);
      if (!heightCapped) setIntrinsicHeight(Math.max(MIN_COMPONENT_HEIGHT_PX, current));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [collapsed, heightCapped, heightResizable]);

  useEffect(() => {
    if (heightDragging || transientHeight === undefined) return;
    const committed = normalizeComponentHeight(height) ?? null;
    if (committed === transientHeight) setTransientHeight(undefined);
  }, [height, heightDragging, transientHeight]);

  // A drag advertises only the boundary under its pointer. Rendering every
  // compatible edge of every component made nested dashboards both noisy and
  // expensive to paint.
  const compositionDropZone = useMemo(() => {
    if (
      !composition?.dragging
      || composition.pointer?.nodeId !== node.id
      || !composition.pointer.zoneId
    ) return null;
    return composition.dropZonesForNode(node, composition.dragging)
      .find((zone) => zone.id === composition.pointer?.zoneId) ?? null;
  }, [composition, node]);

  const beginCompositionPointerMove = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    path: NodePath,
  ): void => {
    if (event.button !== 0) return;
    // Pointer capture keeps a move initiated from a component frame alive when
    // its controls fade during the drag, including in the native WebKit host.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners below are the cross-host fallback.
    }
    pointerMoveRef.current = {
      pointerId: event.pointerId,
      path,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      captureTarget: event.currentTarget,
    };
    compositionPointerSession.start({
      pointerId: event.pointerId,
      onMove: (moveEvent) => {
        const current = pointerMoveRef.current;
        const activeComposition = compositionRef.current;
        if (!current || !activeComposition) return;
        if (!current.active) {
          if (Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) < 6) return;
          current.active = true;
          activeComposition.onNodeDragStart(current.path);
        }
        moveEvent.preventDefault();
        activeComposition.onNodePointerDragMove(current.path, moveEvent);
      },
      onFinish: (finishEvent, reason) => {
        const current = pointerMoveRef.current;
        const activeComposition = compositionRef.current;
        if (!current) return;
        pointerMoveRef.current = null;
        if (current.captureTarget.hasPointerCapture(current.pointerId)) {
          current.captureTarget.releasePointerCapture(current.pointerId);
        }
        if (current.active && reason === "up" && finishEvent instanceof PointerEvent) {
          finishEvent.preventDefault();
          activeComposition?.onNodePointerDrop(current.path, finishEvent);
        }
        if (current.active) activeComposition?.onNodeDragEnd();
      },
    });
  }, [compositionPointerSession]);

  function compositionPointerDrop(event: ReactDragEvent<HTMLElement>): {
    payload: CompositionDragPayload;
    zone: CompositionDropZone;
  } | null {
    if (!composition?.active) return null;
    const eventTarget = event.target instanceof globalThis.Element ? event.target : null;
    if (eventTarget?.closest("[data-composition-controls]")) return null;
    const nearestNode = eventTarget?.closest<HTMLElement>("[data-node-id]");
    if (nearestNode?.dataset.nodeId && nearestNode.dataset.nodeId !== node.id) return null;
    const payload = compositionPayloadFromDragEvent(event.dataTransfer, composition.dragging);
    if (!payload) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const zone = composition.pointerDropZoneForNode(
      node,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      payload,
    );
    return zone && composition.canDrop(zone.target, payload) ? { payload, zone } : null;
  }

  function positionMenu(anchorX: number, anchorY: number, alignRight: boolean): void {
    const width = Math.min(224, window.innerWidth - 24);
    const height = 208;
    const requestedLeft = alignRight ? anchorX - width : anchorX;
    setMenuPosition({
      left: Math.max(12, Math.min(requestedLeft, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(anchorY, window.innerHeight - height - 12)),
    });
  }

  function toggleMenu(): void {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) positionMenu(rect.right, rect.bottom + 5, true);
    setOpen(true);
  }

  useEffect(() => {
    if (showComponentMenu) return;
    setOpen(false);
  }, [showComponentMenu]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuPopoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const closeOnViewportChange = (): void => setOpen(false);
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
  }, [open]);

  function choose(action: () => void): void {
    setOpen(false);
    action();
  }

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);

  /**
   * Single click on frame chrome collapses, double click opens Edit. Only
   * clicks landing on the frame or viewport element itself (background, gaps,
   * padding) qualify: component-rendered content owns its clicks, so selecting
   * text or clicking component surfaces never collapses the frame. Controls,
   * embedded surfaces, composition affordances, and nested component nodes
   * keep their own behavior.
   */
  function isFrameChromeClick(event: ReactMouseEvent<HTMLElement>): boolean {
    if (event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (compositionDragActive || heightDragging || open) return false;
    const target = event.target instanceof globalThis.Element ? event.target : null;
    if (!target) return false;
    // A frame can contain another component frame. Only the nearest frame owns
    // the gesture, otherwise clicking a nested card would collapse ancestors.
    if (target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId !== node.id) return false;
    // Stop at the content boundary: anything inside rendered component content
    // (including static text) belongs to the component, not the frame.
    if (target !== frameRef.current && target !== viewportRef.current) return false;
    if (target.closest(
      "button, a[href], input, select, textarea, audio, video, canvas, iframe,"
      + " [contenteditable='true'], [role='dialog'], [role='menu'],"
      + " [data-composition-controls], [data-composition-drag-handle],"
      + " .component-node__menu, .component-node__menu-popover,"
      + " .component-node__height-resizer, .component-node__drag-handle,"
      + " .composition-drop-indicator, .xterm",
    )) return false;
    // A click that ends a text selection is not a collapse gesture.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return false;
    return true;
  }

  function handleFrameClick(event: ReactMouseEvent<HTMLElement>): void {
    if (!isFrameChromeClick(event)) return;
    // The second click of a double-click also fires click: leave the pending
    // single-click timer alone so double-click wins without collapsing first.
    if (clickTimerRef.current !== null) return;
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      onToggleCollapse();
    }, 260);
  }

  function handleFrameDoubleClick(event: ReactMouseEvent<HTMLElement>): void {
    if (!isFrameChromeClick(event)) return;
    event.preventDefault();
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onEditComponent(node);
  }

  function handleCollapsedClick(event: ReactMouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    if (clickTimerRef.current !== null) return;
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      onToggleCollapse();
    }, 260);
  }

  function handleCollapsedDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    event.preventDefault();
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onEditComponent(node);
  }

  return (
    <Element
      className={`${className}${collapsed ? " component-node--collapsed" : ""}${heightResizable && !collapsed ? " component-node--height-resizable" : ""}${heightCapped ? " component-node--height-capped" : ""}${heightDragging ? " component-node--height-dragging" : ""}${compositionDropZone ? " component-node--drop-ready" : ""}${compositionDragActive ? " component-node--composition-dragging" : ""}${compositionDragSource ? " component-node--composition-drag-source" : ""}`}
      ref={(element) => { frameRef.current = element; }}
      style={frameStyle}
      data-component={node.component}
      data-composition-drag-source={compositionDragSource ? "true" : undefined}
      data-node-id={node.id}
      data-collapsed={collapsed ? "true" : "false"}
      aria-grabbed={compositionDragSource || undefined}
      role={role}
      aria-live={ariaLive}
      onClick={handleFrameClick}
      onDoubleClick={handleFrameDoubleClick}
      onPointerDown={(event) => {
        if (!composition?.active || composition.dragging !== null || !compositionPath || compositionPath.length === 0) return;
        if (canStartCompositionDrag(event, node.id)) {
          // Selection starts on pointerdown, before the movement threshold is
          // crossed. Suppress that native default now so dragging a handle
          // never paints a text selection through the dashboard.
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
          const dragHandle = event.target instanceof globalThis.Element
            ? event.target.closest<HTMLElement>("[data-composition-drag-handle]")
            : null;
          dragHandle?.focus();
          beginCompositionPointerMove(event, compositionPath);
        }
      }}
      onDragOver={(event) => {
        if (!composition?.active) return;
        const knownPayload = compositionPayloadFromDragEvent(event.dataTransfer, composition.dragging);
        if (!knownPayload) {
          // Keep the first WebKit dragover alive while dragstart state catches
          // up, but do not advertise an unknown frame as a real target.
          event.preventDefault();
          event.dataTransfer.dropEffect = "none";
          composition.onDragTarget(null, null);
          return;
        }
        const drop = compositionPointerDrop(event);
        if (!drop) {
          event.dataTransfer.dropEffect = "none";
          composition.onDragTarget(null, null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = drop.payload.type === "node" ? "move" : "copy";
        composition.onDragTarget(node.id, drop.zone);
      }}
      onDragEnter={(event) => {
        if (!composition?.active) return;
        const knownPayload = compositionPayloadFromDragEvent(event.dataTransfer, composition.dragging);
        if (!knownPayload) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "none";
          return;
        }
        const drop = compositionPointerDrop(event);
        if (!drop) {
          composition.onDragTarget(null, null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = drop.payload.type === "node" ? "move" : "copy";
        composition.onDragTarget(node.id, drop.zone);
      }}
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof globalThis.Node && event.currentTarget.contains(related)) return;
        composition?.onDragTarget(null, null);
      }}
      onDrop={(event) => {
        const drop = compositionPointerDrop(event);
        if (!drop) return;
        event.preventDefault();
        composition?.onDragTarget(null, null);
        composition?.onDrop(drop.zone.target, drop.payload);
      }}
      onContextMenu={(event) => {
        if (!showComponentMenu) return;
        event.preventDefault();
        event.stopPropagation();
        positionMenu(event.clientX, event.clientY, false);
        setOpen(true);
      }}
    >
      {compositionPath && compositionPath.length > 0 ? (
        <button
          className="component-node__drag-handle"
          type="button"
          data-composition-drag-handle
          aria-label={`Drag to move ${name} component`}
          title={`Drag to move ${name}`}
          onClick={(event) => event.preventDefault()}
        >
          <svg viewBox="0 0 18 8" aria-hidden="true">
            <circle cx="2" cy="2" r="1.25" />
            <circle cx="9" cy="2" r="1.25" />
            <circle cx="16" cy="2" r="1.25" />
            <circle cx="2" cy="6" r="1.25" />
            <circle cx="9" cy="6" r="1.25" />
            <circle cx="16" cy="6" r="1.25" />
          </svg>
        </button>
      ) : null}
      {showComponentMenu ? <div className="component-node__menu" ref={menuRef}>
        <button
          className="component-node__menu-trigger"
          ref={triggerRef}
          type="button"
          aria-label={`Open ${name} component menu`}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Component menu"
          onClick={toggleMenu}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="4" cy="10" r="1.25" />
            <circle cx="10" cy="10" r="1.25" />
            <circle cx="16" cy="10" r="1.25" />
          </svg>
        </button>
        {open && typeof document !== "undefined" ? createPortal(
          <div
            className="component-node__menu-popover"
            ref={menuPopoverRef}
            role="menu"
            aria-label={`${name} component actions`}
            style={menuPosition}
          >
            <button
              type="button"
              role="menuitem"
              disabled={isVirtualRoot}
              title={isVirtualRoot ? "This component is already focused." : undefined}
              onClick={() => choose(() => onFocus(node.id))}
            >
              <span>Focus component</span>
              {isVirtualRoot ? <small>Focused</small> : null}
            </button>
            <button type="button" role="menuitem" onClick={() => choose(() => onEditComponent(node))}>
              Edit component
            </button>
            <button
              type="button"
              role="menuitem"
              aria-expanded={!collapsed}
              onClick={() => choose(onToggleCollapse)}
            >
              <span>{collapsed ? "Expand component" : "Collapse component"}</span>
              {collapsed ? <small>Collapsed</small> : null}
            </button>
            <button type="button" role="menuitem" onClick={() => choose(() => onCopyPath(node))}>
              Copy component path
            </button>
            <button type="button" role="menuitem" onClick={() => choose(() => onOpenAgent(node))}>
              Change with agent…
            </button>
          </div>,
          document.body,
        ) : null}
      </div> : null}
      {compositionDropZone ? (
        <div
          className={`composition-drop-indicator composition-drop-indicator--${compositionDropZone.side}`}
          data-composition-placement-preview
          aria-hidden="true"
        >
          <div className="composition-drop-indicator__preview">
            <span className="composition-drop-indicator__mode">
              {composition?.dragging?.type === "node" ? "Moving" : "Adding"}
            </span>
            <strong>{compositionDragLabel ?? "Component"}</strong>
            <span className="composition-drop-indicator__target">{compositionDropZone.label}</span>
          </div>
        </div>
      ) : null}
      {collapsed ? (
        <button
          className="component-node__collapsed"
          type="button"
          aria-label={`Expand ${name} component`}
          aria-expanded={false}
          title={`Click to expand, double-click to edit ${name}`}
          onClick={handleCollapsedClick}
          onDoubleClick={handleCollapsedDoubleClick}
        >
          <span className="component-node__collapsed-indicator" aria-hidden="true">›</span>
          <span className="component-node__collapsed-name">{name}</span>
          <span className="component-node__collapsed-summary">
            {descendantCount > 0
              ? `${descendantCount} nested ${descendantCount === 1 ? "component" : "components"}`
              : "Component hidden"}
          </span>
          <span className="component-node__collapsed-action">Expand</span>
        </button>
      ) : (
        <>
          <div className="component-node__viewport" ref={viewportRef}>{children}</div>
          {heightResizable ? (
            <div
              className="component-node__height-resizer"
              role="separator"
              tabIndex={0}
              aria-label={`Resize ${name} height`}
              aria-orientation="horizontal"
              aria-valuemin={Math.min(MIN_COMPONENT_HEIGHT_PX, intrinsicHeight)}
              aria-valuemax={intrinsicHeight}
              aria-valuenow={Math.min(measuredHeight, intrinsicHeight)}
              aria-valuetext={heightCapped ? `${Math.round(effectiveHeight!)} pixels maximum` : "Full height"}
              title="Drag up to make smaller. Press Enter or double-click to restore full height."
              onDoubleClick={() => onHeightChange(null)}
              onFocus={() => setIntrinsicHeight(measureIntrinsicHeight())}
              onKeyDown={(event) => {
                const increment = event.shiftKey ? 48 : 16;
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHeightFromKeyboard(-increment);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHeightFromKeyboard(increment);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setHeightFromKeyboard("minimum");
                } else if (event.key === "End" || event.key === "Enter") {
                  event.preventDefault();
                  setHeightFromKeyboard("full");
                } else if (event.key === "Escape" && heightDragRef.current) {
                  event.preventDefault();
                  finishHeightDrag(heightDragRef.current.pointerId, 0, false);
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const maximumHeight = measureIntrinsicHeight();
                const startHeight = Math.min(
                  maximumHeight,
                  frameRef.current?.getBoundingClientRect().height ?? maximumHeight,
                );
                setIntrinsicHeight(maximumHeight);
                heightDragRef.current = {
                  pointerId: event.pointerId,
                  startY: event.clientY,
                  startHeight,
                  maximumHeight,
                  lastHeight: effectiveHeight,
                  captureTarget: event.currentTarget,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                setHeightDragging(true);
                heightPointerSession.start({
                  pointerId: event.pointerId,
                  onMove: (moveEvent) => {
                  const current = heightDragRef.current;
                  if (!current) return;
                  moveEvent.preventDefault();
                  const next = requestedComponentHeight(
                    current.startHeight,
                    current.startY,
                    moveEvent.clientY,
                    current.maximumHeight,
                  );
                  current.lastHeight = next;
                  setTransientHeight(next);
                  },
                  onFinish: (finishEvent, reason) => {
                    if (reason === "up" && finishEvent) finishHeightDrag(event.pointerId, finishEvent.clientY, true);
                    else if (reason === "lost") finishHeightDrag(event.pointerId, null, true, true);
                    else finishHeightDrag(event.pointerId, null, false);
                  },
                });
              }}
              onPointerUp={(event) => heightPointerSession.finish(event.pointerId, event.nativeEvent)}
              onPointerCancel={(event) => heightPointerSession.finish(event.pointerId, event.nativeEvent, "cancel")}
              onLostPointerCapture={() => {
                const current = heightDragRef.current;
                if (!current) return;
                heightPointerSession.finish(current.pointerId, null, "lost");
              }}
            >
              <span className="component-node__height-resizer-line" aria-hidden="true" />
            </div>
          ) : null}
        </>
      )}
    </Element>
  );
}
