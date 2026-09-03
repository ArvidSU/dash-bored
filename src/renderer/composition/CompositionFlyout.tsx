import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { ComponentCatalogItem, ComponentManifest } from "../../shared/contracts";
import { PERMISSION_LABELS } from "../lib/action-providers";
import { filterComponentCatalog } from "../lib/component-library";
import { compositionPayloadFromDragEvent } from "./composition-dnd";
import type { CompositionDragPayload } from "./composition-context";
import type { NodePath } from "./dashboard-editor";
import { usePointerSession } from "../lib/pointer-session";

export { filterComponentCatalog } from "../lib/component-library";

export const COMPONENT_CATALOG_DRAG_MIME = "application/x-dash-bored-component";

export interface ComponentCatalogDragPayload {
  type: "component";
  reference: string;
}

export interface ComponentPointerDragPoint {
  clientX: number;
  clientY: number;
}

type PointerDragPoint = ComponentPointerDragPoint & { pointerId: number };

export function serializeComponentCatalogDragPayload(reference: string): string {
  return JSON.stringify({ type: "component", reference } satisfies ComponentCatalogDragPayload);
}

export function parseComponentCatalogDragPayload(value: string): ComponentCatalogDragPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as { type?: unknown; reference?: unknown };
    return payload.type === "component"
      && typeof payload.reference === "string"
      && payload.reference.trim().length > 0
      ? { type: "component", reference: payload.reference }
      : null;
  } catch {
    return null;
  }
}

export interface CompositionFlyoutProps {
  open: boolean;
  dragging?: CompositionDragPayload | null;
  catalog: readonly ComponentCatalogItem[];
  onClose: () => void;
  onInsert: (entry: ComponentCatalogItem) => void;
  onRemoveDrop?: (path: NodePath) => void;
  onBuildWithAgent?: (description: string) => void;
  onDragStateChange?: (entry: ComponentCatalogItem | null) => void;
  onPointerDragMove?: (reference: string, point: ComponentPointerDragPoint) => void;
  onPointerDrop?: (reference: string, point: ComponentPointerDragPoint) => void;
  agentPending?: boolean;
  loading?: boolean;
  title?: string;
}

const provenanceLabels: Record<ComponentCatalogItem["source"], string> = {
  builtin: "Built in",
  local: "Project local",
  config: "Linked config",
};

function childContract(manifest: ComponentManifest): ReactNode {
  const definition = manifest.children;
  if (!definition) return <span>Children: none</span>;
  const maximum = definition.max === undefined ? "no limit" : String(definition.max);
  const presentation = definition.presentation.type === "managed"
    ? "managed by the component"
    : definition.presentation.axes === "both"
      ? "tiled horizontally or vertically"
      : `tiled ${definition.presentation.axes === "horizontal" ? "horizontally" : "vertically"}`;
  return (
    <span>
      Children: minimum {definition.min}, maximum {maximum}; {presentation}
    </span>
  );
}

const flyoutStyle: CSSProperties = {
  position: "fixed",
  zIndex: 90,
  insetBlock: 0,
  insetInlineEnd: 0,
  width: "min(28rem, 100vw)",
  boxSizing: "border-box",
  display: "grid",
  gridTemplateRows: "auto auto minmax(0, 1fr)",
  gap: "0.8rem",
  padding: "calc(var(--window-chrome-height, 32px) + 1rem) 1rem 1rem",
  overflow: "hidden",
  color: "var(--text, #f4f4f4)",
  background: "var(--panel, #191919)",
  borderInlineStart: "1px solid var(--border, #3a3a3a)",
  boxShadow: "-1rem 0 2.5rem rgb(0 0 0 / 0.32)",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "0.55rem",
  padding: "0.85rem",
  border: "1px solid var(--border, #3a3a3a)",
  borderRadius: "0.7rem",
  background: "var(--surface, #222)",
};

const FLYOUT_TRANSITION_MS = 220;

export function CompositionFlyout({
  open,
  dragging: compositionDragging = null,
  catalog,
  onClose,
  onInsert,
  onRemoveDrop,
  onBuildWithAgent,
  onDragStateChange,
  onPointerDragMove,
  onPointerDrop,
  agentPending = false,
  loading = false,
  title = "Component library",
}: CompositionFlyoutProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const flyoutRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pointerDragRef = useRef<{
    entry: ComponentCatalogItem;
    pointerId: number;
    startX: number;
    startY: number;
    button: HTMLButtonElement;
    active: boolean;
  } | null>(null);
  const pointerSession = usePointerSession();
  const suppressClickRef = useRef(false);
  const [query, setQuery] = useState("");
  const [draggingReference, setDraggingReference] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [removeDropHovered, setRemoveDropHovered] = useState(false);
  const filteredCatalog = useMemo(
    () => filterComponentCatalog(catalog, query),
    [catalog, query],
  );
  const hasMatchingAvailableEntry = filteredCatalog.some((entry) =>
    entry.available && entry.manifest !== null);
  const agentDescription = query.trim();
  const showAgentFallback = agentDescription.length > 0
    && !loading
    && !hasMatchingAvailableEntry
    && onBuildWithAgent !== undefined;
  const removalMode = open && compositionDragging?.type === "node";

  function removeDropPath(event: ReactDragEvent<HTMLElement>): NodePath | null {
    if (!removalMode) return null;
    const payload = compositionPayloadFromDragEvent(event.dataTransfer, compositionDragging);
    return payload?.type === "node" && payload.path.length > 0 ? payload.path : null;
  }

  function handleRemoveDragOver(event: ReactDragEvent<HTMLElement>): void {
    const path = removeDropPath(event);
    if (!path || !onRemoveDrop) {
      event.dataTransfer.dropEffect = "none";
      setRemoveDropHovered(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setRemoveDropHovered(true);
  }

  function handleRemoveDragLeave(event: ReactDragEvent<HTMLElement>): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof globalThis.Node && event.currentTarget.contains(relatedTarget)) return;
    setRemoveDropHovered(false);
  }

  function handleRemoveDrop(event: ReactDragEvent<HTMLElement>): void {
    const path = removeDropPath(event);
    if (!path || !onRemoveDrop) return;
    event.preventDefault();
    setRemoveDropHovered(false);
    onRemoveDrop(path);
  }

  useEffect(() => {
    let openFrame: number | undefined;
    let closeTimer: number | undefined;
    if (open) {
      setRendered(true);
      openFrame = requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      closeTimer = window.setTimeout(() => setRendered(false), FLYOUT_TRANSITION_MS);
    }
    return () => {
      if (openFrame !== undefined) cancelAnimationFrame(openFrame);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setQuery("");
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      const target = restoreFocusRef.current;
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
        else document.querySelector<HTMLElement>(".composition-library-trigger")?.focus();
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: globalThis.PointerEvent): void => {
      if (event.button !== 0 || flyoutRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(flyoutRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])",
      ) ?? []).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey ? active === first : active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!flyoutRef.current?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (open || draggingReference === null) return;
    setDraggingReference(null);
    onDragStateChange?.(null);
  }, [draggingReference, onDragStateChange, open]);

  useEffect(() => {
    if (open) return;
    pointerSession.cancel();
    const current = pointerDragRef.current;
    if (!current) return;
    pointerDragRef.current = null;
    if (current.button.hasPointerCapture(current.pointerId)) {
      current.button.releasePointerCapture(current.pointerId);
    }
    suppressClickRef.current = false;
    setDraggingReference(null);
    onDragStateChange?.(null);
  }, [onDragStateChange, open, pointerSession]);

  useEffect(() => {
    if (removalMode) return;
    setRemoveDropHovered(false);
  }, [removalMode]);

  const beginPointerDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    entry: ComponentCatalogItem,
  ): void => {
    if (!entry.available || !entry.manifest || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      entry,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      button: event.currentTarget,
      active: false,
    };
    pointerSession.start({
      pointerId: event.pointerId,
      onMove: (moveEvent) => {
        if (movePointerDrag({
          pointerId: moveEvent.pointerId,
          clientX: moveEvent.clientX,
          clientY: moveEvent.clientY,
        })) moveEvent.preventDefault();
      },
      onFinish: (finishEvent, reason) => {
        const current = pointerDragRef.current;
        if (!current) return;
        finishPointerDrag({
          pointerId: current.pointerId,
          clientX: finishEvent?.clientX ?? current.startX,
          clientY: finishEvent?.clientY ?? current.startY,
        }, reason !== "up");
      },
    });
  };

  const movePointerDrag = (point: PointerDragPoint): boolean => {
    const current = pointerDragRef.current;
    if (!current || current.pointerId !== point.pointerId) return false;
    if (!current.active) {
      const distance = Math.hypot(point.clientX - current.startX, point.clientY - current.startY);
      if (distance < 6) return false;
      current.active = true;
      setDraggingReference(current.entry.reference);
      onDragStateChange?.(current.entry);
    }
    onPointerDragMove?.(current.entry.reference, {
      clientX: point.clientX,
      clientY: point.clientY,
    });
    return true;
  };

  const finishPointerDrag = (
    point: PointerDragPoint,
    cancelled: boolean,
  ): void => {
    const current = pointerDragRef.current;
    if (!current || current.pointerId !== point.pointerId) return;
    if (current.active && !cancelled) {
      suppressClickRef.current = true;
      onPointerDrop?.(current.entry.reference, {
        clientX: point.clientX,
        clientY: point.clientY,
      });
    }
    if (current.button.hasPointerCapture(current.pointerId)) {
      current.button.releasePointerCapture(current.pointerId);
    }
    pointerDragRef.current = null;
    setDraggingReference(null);
    onDragStateChange?.(null);
    if (current.active) {
      requestAnimationFrame(() => {
        suppressClickRef.current = false;
      });
    }
    if (!cancelled) current.button.focus();
  };

  if (!rendered) return null;

  const foldsForDrag = !removalMode
    && (compositionDragging?.type === "component" || draggingReference !== null);
  const flyoutClassName = [
    "composition-flyout",
    open && visible ? "composition-flyout--open" : "",
    foldsForDrag ? "composition-flyout--dragging" : "",
    removalMode ? "composition-flyout--removal" : "",
    removeDropHovered ? "composition-flyout--removal-hovered" : "",
  ].filter(Boolean).join(" ");
  const activeFlyoutStyle = removalMode
    ? {
        ...flyoutStyle,
        width: "20vw",
        gridTemplateRows: "1fr",
        gap: 0,
        padding: "calc(var(--window-chrome-height, 32px) + 1rem) 1rem 1rem",
        placeItems: "center",
        borderInlineStart: "2px dotted var(--accent, #d9ff68)",
      }
    : flyoutStyle;

  if (removalMode) {
    return (
      <aside
        data-composition-removal-target
        aria-hidden="false"
        aria-label="Remove component"
        aria-modal="false"
        className={flyoutClassName}
        ref={flyoutRef}
        role="dialog"
        style={activeFlyoutStyle}
        onDragEnter={handleRemoveDragOver}
        onDragLeave={handleRemoveDragLeave}
        onDragOver={handleRemoveDragOver}
        onDrop={handleRemoveDrop}
      >
        <svg className="composition-flyout__trash" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M9 7V4h6v3" />
          <path d="m6 7 1 13h10l1-13" />
          <path d="M10 11v5M14 11v5" />
        </svg>
        <span className="visually-hidden">Drop the component here to remove it.</span>
      </aside>
    );
  }

  return (
    <aside
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-hidden={!open}
      aria-modal="false"
      className={flyoutClassName}
      ref={flyoutRef}
      role="dialog"
      style={activeFlyoutStyle}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <h2 id={titleId} style={{ margin: 0 }}>{title}</h2>
          <p id={descriptionId} style={{ margin: "0.3rem 0 0", color: "var(--text-muted, #aaa)" }}>
            {loading
              ? "Loading the catalog for the focused dashboard bundle."
              : "Insert with the button or drag an available component onto the dashboard."}
          </p>
        </div>
        <button className="button button--quiet" type="button" aria-label={`Close ${title}`} onClick={onClose}>
          Close
        </button>
      </header>

      <label style={{ display: "grid", gap: "0.35rem" }}>
        <span>Search components</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search or describe what to build…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <small aria-live="polite">
          {loading
            ? "Loading the focused dashboard bundle…"
            : `${filteredCatalog.length} of ${catalog.length} catalog entries shown`}
        </small>
      </label>

      <div style={{ minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        <ul aria-label="Component catalog" style={{ display: "grid", gap: "0.75rem", margin: 0, padding: 0, listStyle: "none" }}>
          {filteredCatalog.map((entry) => {
            const manifest = entry.manifest;
            const available = !loading && entry.available && manifest !== null;
            const name = manifest?.name ?? entry.reference;
            const dragging = draggingReference === entry.reference;
            return (
              <li key={`${entry.source}:${entry.reference}`} style={{ ...cardStyle, opacity: available ? 1 : 0.72 }}>
                <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "0.75rem" }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block" }}>{name}</strong>
                    <code style={{ overflowWrap: "anywhere" }}>{entry.reference}</code>
                  </div>
                  <span style={{ whiteSpace: "nowrap" }}>{provenanceLabels[entry.source]}</span>
                </div>
                <p style={{ margin: 0 }}>{manifest?.description ?? "Manifest metadata is unavailable."}</p>
                {manifest ? (
                  <div style={{ display: "grid", gap: "0.25rem", color: "var(--text-muted, #bbb)" }}>
                    <span>
                      Sizing: {manifest.renderMode === "layout" ? "organizational layout" : "resizable surface"}
                    </span>
                    {childContract(manifest)}
                    <span>
                      Permissions: {manifest.permissions?.length
                        ? manifest.permissions.map((permission) => PERMISSION_LABELS[permission]).join(", ")
                        : "none"}
                    </span>
                  </div>
                ) : null}
                {!available ? (
                  <div role="alert" style={{ padding: "0.6rem", borderRadius: "0.45rem", background: "rgb(160 45 45 / 0.2)" }}>
                    <strong>Unavailable</strong>
                    {entry.diagnostics.length > 0 ? (
                      <ul style={{ margin: "0.35rem 0 0", paddingInlineStart: "1.2rem" }}>
                        {entry.diagnostics.map((diagnostic, index) => (
                          <li key={`${diagnostic.code}:${index}`}>
                            {diagnostic.severity}: {diagnostic.message} <code>{diagnostic.code}</code>
                          </li>
                        ))}
                      </ul>
                    ) : <p style={{ margin: "0.35rem 0 0" }}>No availability diagnostic was supplied.</p>}
                  </div>
                ) : null}
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={!available}
                  aria-grabbed={dragging}
                  style={{ touchAction: "none" }}
                  onClick={(event) => {
                    if (suppressClickRef.current) {
                      event.preventDefault();
                      return;
                    }
                    onInsert(entry);
                  }}
                  onPointerDown={(event) => beginPointerDrag(event, entry)}
                  onPointerUp={(event) => pointerSession.finish(event.pointerId, event.nativeEvent)}
                  onPointerCancel={(event) => pointerSession.finish(event.pointerId, event.nativeEvent, "cancel")}
                  onLostPointerCapture={(event) => pointerSession.finish(event.pointerId, event.nativeEvent, "lost")}
                >
                  {dragging ? `Dragging ${name}` : `Insert ${name}`}
                </button>
              </li>
            );
          })}
        </ul>

        {filteredCatalog.length === 0 ? (
          <p role="status">No catalog entries match “{agentDescription}”.</p>
        ) : null}

        {showAgentFallback ? (
          <div style={{ ...cardStyle, marginTop: "0.75rem" }}>
            <strong>Build with agent</strong>
            <p style={{ margin: 0 }}>Create a component for “{agentDescription}”.</p>
            <button
              className="button button--primary"
              type="button"
              disabled={agentPending}
              onClick={() => onBuildWithAgent?.(agentDescription)}
            >
              {agentPending ? "Starting agent…" : `Build “${agentDescription}” with agent`}
            </button>
          </div>
        ) : null}
      </div>

      <p role="status" aria-live="polite" style={{ position: "absolute", inlineSize: 1, blockSize: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {draggingReference ? `Dragging ${draggingReference}. Choose a dashboard insertion target.` : ""}
      </p>
    </aside>
  );
}
