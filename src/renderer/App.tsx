import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type {
  AppSettings,
  ComponentNode,
  DashboardConfig,
  DashboardDraftValidation,
  Diagnostic,
  ComponentCatalogItem,
  LocalComponentHost,
  ProcessSnapshot,
  ProjectDeletionPreview,
  ProjectListItem,
  ProjectOutline,
  ProjectSnapshot,
  ProjectTarget,
  ResolvedComponentNode,
} from "../shared/contracts";
import {
  buildComponentCreationAgentPrompt,
  componentPath,
  dashboardInsertionPath,
} from "../shared/component-agent";
import {
  buildApplicationActions,
  buildNodeFocusActions,
  hasLocalNode,
  PERMISSION_LABELS,
  projectLabel,
} from "./action-providers";
import type { AppView } from "./action-providers";
import { ActionExecutor, ActionRegistry } from "./actions";
import type { PaletteAction } from "./actions";
import { packagedComponent } from "./builtins";
import { writeClipboardText } from "./clipboard";
import { CommandPalette } from "./CommandPalette";
import {
  changedComponentIds,
  updateStaggerMs,
} from "./component-updates";
import {
  collapsedComponentsStorageKey,
  collectComponentNodeIds,
  countComponentDescendants,
  parseCollapsedComponentIds,
  serializeCollapsedComponentIds,
} from "./component-view-state";
import {
  componentHeightOverridesStorageKey,
  componentRendersSurface,
  MIN_COMPONENT_HEIGHT_PX,
  normalizeComponentHeight,
  parseComponentHeightOverrides,
  pruneComponentHeightOverrides,
  serializeComponentHeightOverrides,
  type ComponentHeightOverrides,
} from "./component-height";
import {
  ComponentVisibilityContext,
  composeComponentChildren,
} from "./ComponentCompositor";
import { ComponentWebviewSurface } from "./ComponentWebviewSurface";
import {
  normalizeSplitRatio,
  parseSplitRatioOverrides,
  pruneSplitRatioOverrides,
  serializeSplitRatioOverrides,
  splitRatioMatches,
  splitRatioOverridesStorageKey,
  type SplitRatioOverrides,
} from "./split-layout";
import { AppShell, type ProjectOutlineState } from "./app-shell";
import {
  DashboardEditor,
  ComponentDialog,
  DashboardEditorToolbar,
  EditorModal,
} from "./DashboardEditor";
import {
  catalogManifest,
  countNodes,
  defaultChildMetadata,
  nodeAtPath,
  pathEquals,
  nodePathFromSourcePath,
  nodePathById,
  removeNode,
  updateTiledSplitRatio,
  type InsertionTarget,
  type NodePath,
} from "./dashboard-editor";
import {
  childEdges,
  edgeAtLocator,
  type LayoutBranch,
} from "./component-children";
import {
  deriveInsertionTargets,
} from "./composition-placement";
import { buildCompositionPreviewTree } from "./composition-preview";
import { planCompositionOperation } from "./composition-operation";
import { CompositionFlyout } from "./CompositionFlyout";
import type { ComponentPointerDragPoint } from "./CompositionFlyout";
import {
  LocalComponentErrorBoundary,
  useLocalComponents,
} from "./local-components";
import type { LoadedLocalComponent } from "./local-components";
import { host } from "./rpc-client";
import { nodeLabel, resolveVirtualRoot, virtualRootStorageKey } from "./virtual-root";
import {
  CompositionContext,
  type CompositionDragPayload,
  type CompositionDropZone,
  type CompositionTarget,
} from "./composition-context";
import {
  compatibleCompositionDropZones,
  compositionPayloadFromDragEvent,
} from "./composition-dnd";
import { useCompositionInteractionController } from "./composition-interaction-controller";
import { usePointerSession } from "./pointer-session";

const EMPTY_COLLAPSED_COMPONENT_IDS = new Set<string>();
const EMPTY_SPLIT_RATIO_OVERRIDES: Readonly<SplitRatioOverrides> = Object.freeze({});
const EMPTY_COMPONENT_HEIGHT_OVERRIDES: Readonly<ComponentHeightOverrides> = Object.freeze({});

function replaceProcess(
  snapshot: ProjectSnapshot,
  process: ProcessSnapshot,
): ProjectSnapshot {
  const index = snapshot.processes.findIndex((item) => item.id === process.id);
  const processes = [...snapshot.processes];
  if (index === -1) processes.push(process);
  else processes[index] = process;
  return { ...snapshot, processes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function resolvedNodeById(
  root: ResolvedComponentNode,
  id: string,
): ResolvedComponentNode | null {
  if (root.id === id) return root;
  for (const edge of childEdges(root.children)) {
    const match = resolvedNodeById(edge.node, id);
    if (match) return match;
  }
  return null;
}

function rememberProject(
  projects: ProjectListItem[],
  snapshot: ProjectSnapshot,
): ProjectListItem[] {
  if (snapshot.projectRoot === null || snapshot.configPath === undefined || snapshot.configPath === null) return projects;
  const item: ProjectListItem = {
    projectRoot: snapshot.projectRoot,
    configPath: snapshot.configPath,
    dashboardName: snapshot.dashboardName,
    iconDataUrl: snapshot.iconDataUrl,
  };
  const existingIndex = projects.findIndex(
    (project) => project.configPath === item.configPath,
  );
  if (existingIndex === -1) return [...projects, item];
  const next = [...projects];
  next[existingIndex] = item;
  return next;
}

function dashboardKey(project: ProjectListItem): string {
  return project.configPath;
}

interface ActionNotice {
  id: number;
  message: string;
}

interface DashboardEditSession {
  projectRoot: string;
  configPath: string;
  componentCatalog: ComponentCatalogItem[];
  original: DashboardConfig;
  draft: DashboardConfig;
  expectedConfigRevision: string;
  validation: DashboardDraftValidation;
}

interface DashboardCompositionSource {
  projectRoot: string;
  activeDashboardPath: string;
  focusedSourcePath: string;
  snapshotRevision: number;
  configPath: string;
  componentCatalog: ComponentCatalogItem[];
  config: DashboardConfig;
}

function compositionTargetId(target: CompositionTarget): string {
  return JSON.stringify(target);
}

function isRootCompositionTarget(
  target: CompositionTarget,
): target is { type: "root-replacement"; path: [] } {
  return "type" in target && target.type === "root-replacement";
}

function findResolvedConfigRoot(
  node: ResolvedComponentNode,
  configPath: string,
): ResolvedComponentNode | null {
  if (node.sourceConfigPath === configPath && node.sourcePath === "root") return node;
  for (const edge of childEdges(node.children)) {
    const match = findResolvedConfigRoot(edge.node, configPath);
    if (match) return match;
  }
  return null;
}

function linkedComponentIdNamespace(
  template: ResolvedComponentNode,
  rawRoot: ComponentNode,
): string | undefined {
  const rawRootId = rawRoot.id ?? "root";
  const suffix = `::${rawRootId}`;
  if (template.id.endsWith(suffix)) return template.id.slice(0, -suffix.length);
  const separator = template.id.lastIndexOf("::");
  return separator > 0 ? template.id.slice(0, separator) : undefined;
}

function compositionTargetLabel(target: CompositionTarget): string {
  if (isRootCompositionTarget(target)) return "Replace dashboard root";
  const placement = target.placement;
  if (placement.type === "managed") return `Insert child ${placement.index + 1}`;
  if (placement.axis === "horizontal") return placement.position === "first" ? "Tile left" : "Tile right";
  return placement.position === "first" ? "Tile above" : "Tile below";
}

function configuredNodeLabel(
  node: ComponentNode,
  catalog: readonly ComponentCatalogItem[],
  metadata: Record<string, unknown> = {},
): string {
  const edgeLabel = metadata.label;
  if (typeof edgeLabel === "string" && edgeLabel.trim()) return edgeLabel.trim();
  const title = node.props?.title ?? node.props?.label ?? node.props?.name;
  if (typeof title === "string" && title.trim()) return title.trim();
  return catalogManifest(catalog, node.component)?.name
    ?? node.component.replace(/^@dash-bored\//, "");
}

/** A compact label for the thing currently being placed, not its destination. */
function compositionPayloadLabel(
  payload: CompositionDragPayload,
  config: DashboardConfig,
  catalog: readonly ComponentCatalogItem[],
): string {
  if (payload.type === "component") {
    return catalogManifest(catalog, payload.reference)?.name
      ?? payload.reference.replace(/^@dash-bored\//, "");
  }
  try {
    return configuredNodeLabel(nodeAtPath(config.root, payload.path), catalog);
  } catch {
    // The move planner will reject an out-of-date source. Keep the transient
    // preview descriptive without treating the stale path as a valid node.
    return "Component";
  }
}

function contextualInsertionLabel(
  parent: ComponentNode,
  target: InsertionTarget,
  catalog: readonly ComponentCatalogItem[],
): string {
  const placement = target.placement;
  const parentLabel = configuredNodeLabel(parent, catalog);
  if (!parent.children) return `Add inside ${parentLabel}`;
  if (placement.type === "managed") {
    if (parent.children.type !== "managed") return compositionTargetLabel(target);
    const before = parent.children.items[placement.index - 1];
    const after = parent.children.items[placement.index];
    if (!before && after) {
      return `Insert before ${configuredNodeLabel(after.node, catalog, after.metadata)}`;
    }
    if (before && !after) {
      return `Insert after ${configuredNodeLabel(before.node, catalog, before.metadata)}`;
    }
    if (before && after) {
      return `Insert between ${configuredNodeLabel(before.node, catalog, before.metadata)} and ${configuredNodeLabel(after.node, catalog, after.metadata)}`;
    }
    return `Add inside ${parentLabel}`;
  }
  try {
    const edge = edgeAtLocator(parent.children, { type: "tiled", path: placement.path });
    const childLabel = configuredNodeLabel(edge.node, catalog, edge.metadata);
    if (placement.axis === "horizontal") {
      return placement.position === "first"
        ? `Tile left of ${childLabel}`
        : `Tile right of ${childLabel}`;
    }
    return placement.position === "first"
      ? `Tile above ${childLabel}`
      : `Tile below ${childLabel}`;
  } catch {
    return compositionTargetLabel(target);
  }
}

function compositionDropZoneSide(
  target: InsertionTarget,
  targetChildPath: NodePath[number] | undefined,
): CompositionDropZone["side"] {
  const placement = target.placement;
  if (placement.type === "managed") {
    return targetChildPath?.type === "managed" && placement.index <= targetChildPath.index
      ? "left"
      : "right";
  }
  if (placement.axis === "horizontal") return placement.position === "first" ? "left" : "right";
  return placement.position === "first" ? "top" : "bottom";
}

function outlineError(outline: Pick<ProjectOutline, "tree" | "diagnostics">): string | null {
  if (outline.tree) return null;
  return outline.diagnostics.find((item) => item.severity === "error")?.message
    ?? "The dashboard tree is unavailable.";
}


function createLocalHost(
  node: ResolvedComponentNode,
  actionRegistry: ActionRegistry,
  actionScope: string,
  trusted: boolean,
  processes: ReadonlyMap<string, ProcessSnapshot>,
): LocalComponentHost {
  const permissions = new Set(node.manifest?.permissions ?? []);
  const actionOwner = {
    scope: actionScope,
    nodeId: node.id,
    componentName: node.manifest?.name ?? node.component,
  };
  const componentHost: LocalComponentHost = {
    dashboard: {
      async reload(): Promise<void> {
        await host.reloadProject();
      },
    },
    actions: {
      register(action) {
        return actionRegistry.register(actionOwner, action);
      },
    },
  };

  if (permissions.has("filesystem:read") || permissions.has("filesystem:write")) {
    componentHost.filesystem = {
      readText(path) {
        return host.readTextFile({ nodeId: node.id, path });
      },
      ...(permissions.has("filesystem:write")
        ? {
            writeText(path, content) {
              return host.writeTextFile({ nodeId: node.id, path, content });
            },
          }
        : {}),
    };
  }

  if (permissions.has("network:http")) {
    componentHost.http = {
      request(request) {
        return host.httpRequest({ ...request, nodeId: node.id });
      },
    };
  }

  if (permissions.has("process:execute")) {
    componentHost.shell = {
      run(request) {
        return host.runShell({ ...request, nodeId: node.id });
      },
    };
  }

  if (permissions.has("process:execute") || permissions.has("process:observe")) {
    componentHost.processes = {
      get(nodeId = node.id) {
        return processes.get(nodeId);
      },
      ...(permissions.has("process:execute")
        ? {
            start() {
              return host.startProcess(node.id);
            },
            open() {
              return host.openProcessTerminal(node.id);
            },
            runQuickAction() {
              return host.runProcessQuickAction(node.id);
            },
            write(input) {
              return host.writeProcessTerminal(node.id, input);
            },
            resize(cols, rows) {
              return host.resizeProcessTerminal(node.id, cols, rows);
            },
            stop() {
              return host.stopProcess(node.id);
            },
          }
        : {}),
    };
  }

  if (trusted && permissions.has("webview:embed")) {
    componentHost.webview = {
      render(request) {
        return <ComponentWebviewSurface url={request.url} title={request.title} />;
      },
    };
  }

  return componentHost;
}

interface ComponentFrameProps {
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

function canStartCompositionHeaderDrag(
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
  // A component's own header is its only direct-manipulation affordance. This
  // keeps normal content (including inputs and live controls) untouched while
  // avoiding a second editor toolbar around every frame.
  if (!target.closest("header, h1, h2, h3, [data-component-drag-header]")) return false;
  return !target.closest("button, a, input, select, textarea, [contenteditable='true'], [role='button'], [role='slider'], [role='tab']");
}

function ComponentFrame({
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
      onHeightChange(null);
      return;
    }
    const currentHeight = frameRef.current?.getBoundingClientRect().height ?? maximumHeight;
    const requested = delta === "minimum"
      ? Math.min(MIN_COMPONENT_HEIGHT_PX, maximumHeight)
      : currentHeight + delta;
    const next = Math.max(Math.min(MIN_COMPONENT_HEIGHT_PX, maximumHeight), Math.min(maximumHeight, requested));
    onHeightChange(next >= maximumHeight - 1 ? null : Math.round(next));
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

  return (
    <Element
      className={`${className}${collapsed ? " component-node--collapsed" : ""}${heightResizable && !collapsed ? " component-node--height-resizable" : ""}${heightCapped ? " component-node--height-capped" : ""}${heightDragging ? " component-node--height-dragging" : ""}${compositionDropZone ? " component-node--drop-ready" : ""}${compositionPath && compositionPath.length > 0 ? " component-node--composition-draggable" : ""}${compositionDragActive ? " component-node--composition-dragging" : ""}${compositionDragSource ? " component-node--composition-drag-source" : ""}`}
      ref={(element) => { frameRef.current = element; }}
      style={frameStyle}
      data-component={node.component}
      data-composition-drag-source={compositionDragSource ? "true" : undefined}
      data-node-id={node.id}
      data-collapsed={collapsed ? "true" : "false"}
      aria-grabbed={compositionDragSource || undefined}
      role={role}
      aria-live={ariaLive}
      onPointerDown={(event) => {
        if (!composition?.active || composition.dragging !== null || !compositionPath || compositionPath.length === 0) return;
        if (canStartCompositionHeaderDrag(event, node.id)) {
          // Selection starts on pointerdown, before the movement threshold is
          // crossed. Suppress that native default now so dragging a header
          // never paints a text selection through the dashboard.
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
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
          onClick={onToggleCollapse}
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

interface NodeRendererProps {
  node: ResolvedComponentNode;
  trusted: boolean;
  processes: ReadonlyMap<string, ProcessSnapshot>;
  localComponents: ReadonlyMap<string, LoadedLocalComponent>;
  actionRegistry: ActionRegistry;
  actionScope: string;
  updateBatch: ComponentUpdateBatch | null;
  collapsedNodeIds: ReadonlySet<string>;
  splitRatioOverrides: Readonly<SplitRatioOverrides>;
  componentHeightOverrides: Readonly<ComponentHeightOverrides>;
  onFocus: (nodeId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onSplitRatioChange: (
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
    node: ResolvedComponentNode,
    splitPath: readonly LayoutBranch[],
  ) => void;
  onComponentHeightChange: (nodeId: string, height: number | null) => void;
  onCopyPath: (node: ResolvedComponentNode) => void;
  onEditComponent: (node: ResolvedComponentNode) => void;
  onOpenAgent: (node: ResolvedComponentNode) => void;
  isVirtualRoot?: boolean;
}

interface ComponentUpdateBatch {
  generation: number;
  delays: ReadonlyMap<string, number>;
}

function ComponentUpdatePolish({
  batch,
  nodeId,
}: {
  batch: ComponentUpdateBatch | null;
  nodeId: string;
}): ReactNode {
  const delay = batch?.delays.get(nodeId);
  if (batch === null || delay === undefined) return null;
  return (
    <span
      aria-hidden="true"
      className="component-node__update-polish"
      key={`${nodeId}:${batch.generation}`}
      style={{ "--component-update-delay": `${delay}ms` } as CSSProperties}
    />
  );
}

function NodeRenderer({
  node,
  trusted,
  processes,
  localComponents,
  actionRegistry,
  actionScope,
  updateBatch,
  collapsedNodeIds,
  splitRatioOverrides,
  componentHeightOverrides,
  onFocus,
  onToggleCollapse,
  onSplitRatioChange,
  onComponentHeightChange,
  onCopyPath,
  onEditComponent,
  onOpenAgent,
  isVirtualRoot = false,
}: NodeRendererProps): ReactNode {
  const permissionsKey = (node.manifest?.permissions ?? []).join("\u0000");
  const localHost = useMemo(
    () => createLocalHost(node, actionRegistry, actionScope, trusted, processes),
    [actionRegistry, actionScope, node.id, node.manifest?.name, permissionsKey, processes, trusted],
  );
  useEffect(
    () => () => actionRegistry.clearOwner({ scope: actionScope, nodeId: node.id }),
    [actionRegistry, actionScope, node.id],
  );
  const collapsed = collapsedNodeIds.has(node.id);
  const frameHeightProps = {
    height: componentHeightOverrides[node.id],
    heightResizable: componentRendersSurface(node),
    onHeightChange: (height: number | null) => onComponentHeightChange(node.id, height),
  };
  const renderedChildren = collapsed
    ? undefined
    : composeComponentChildren({
        node,
        splitRatioOverrides,
        onSplitRatioChange,
        renderNode: (child) => (
          <NodeRenderer
            key={child.id}
            node={child}
            trusted={trusted}
            processes={processes}
            localComponents={localComponents}
            actionRegistry={actionRegistry}
            actionScope={actionScope}
            updateBatch={updateBatch}
            collapsedNodeIds={collapsedNodeIds}
            splitRatioOverrides={splitRatioOverrides}
            componentHeightOverrides={componentHeightOverrides}
            onFocus={onFocus}
            onToggleCollapse={onToggleCollapse}
            onSplitRatioChange={onSplitRatioChange}
            onComponentHeightChange={onComponentHeightChange}
            onCopyPath={onCopyPath}
            onEditComponent={onEditComponent}
            onOpenAgent={onOpenAgent}
          />
        ),
      });

  if (node.source === "builtin") {
    const Component = packagedComponent(node.component);
    return (
      <ComponentFrame
        {...frameHeightProps}
        node={node}
        className="component-node"
        isVirtualRoot={isVirtualRoot}
        collapsed={collapsed}
        onFocus={onFocus}
        onToggleCollapse={() => onToggleCollapse(node.id)}
        onCopyPath={onCopyPath}
        onEditComponent={onEditComponent}
        onOpenAgent={onOpenAgent}
      >
        {!collapsed ? (
          <>
            {Component ? (
              <Component props={node.props} children={renderedChildren} host={localHost} />
            ) : (
              <div className="component-state component-state--error" role="alert">
                Unknown packaged component <code>{node.component}</code>.
              </div>
            )}
            <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
          </>
        ) : null}
      </ComponentFrame>
    );
  }

  if (node.source === "config") {
    const name = node.configName?.trim() || node.component;
    return (
      <ComponentFrame
        {...frameHeightProps}
        as="section"
        node={node}
        className="component-node config-link"
        isVirtualRoot={isVirtualRoot}
        collapsed={collapsed}
        onFocus={onFocus}
        onToggleCollapse={() => onToggleCollapse(node.id)}
        onCopyPath={onCopyPath}
        onEditComponent={onEditComponent}
        onOpenAgent={onOpenAgent}
      >
        {!collapsed ? (
          <>
            {node.configError ? (
              <div className="component-state component-state--error" role="alert">
                <strong>Could not load {name}</strong>
                <span>{node.configError}</span>
                <code>{node.configPath ?? node.component}</code>
              </div>
            ) : (
              <div className="config-link__content">
                {renderedChildren?.type === "tiled" ? renderedChildren.surface : null}
              </div>
            )}
            <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
          </>
        ) : null}
      </ComponentFrame>
    );
  }

  const name = node.manifest?.name ?? node.component;
  if (!trusted) {
    return (
      <ComponentFrame
        {...frameHeightProps}
        node={node}
        className="component-node component-state component-state--locked"
        isVirtualRoot={isVirtualRoot}
        collapsed={collapsed}
        onFocus={onFocus}
        onToggleCollapse={() => onToggleCollapse(node.id)}
        onCopyPath={onCopyPath}
        onEditComponent={onEditComponent}
        onOpenAgent={onOpenAgent}
      >
        {!collapsed ? (
          <>
            <span className="component-state__icon" aria-hidden="true">◇</span>
            <strong>{name}</strong>
            <span>Trust this project to load its local component code.</span>
            <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
          </>
        ) : null}
      </ComponentFrame>
    );
  }

  const componentId = node.manifest?.id;
  const loaded = componentId ? localComponents.get(componentId) : undefined;
  if (!componentId) {
    return (
      <ComponentFrame
        {...frameHeightProps}
        node={node}
        className="component-node component-state component-state--error"
        isVirtualRoot={isVirtualRoot}
        collapsed={collapsed}
        role="alert"
        onFocus={onFocus}
        onToggleCollapse={() => onToggleCollapse(node.id)}
        onCopyPath={onCopyPath}
        onEditComponent={onEditComponent}
        onOpenAgent={onOpenAgent}
      >
        {!collapsed ? (
          <>
            Local component <code>{node.component}</code> has no manifest ID.
            <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
          </>
        ) : null}
      </ComponentFrame>
    );
  }

  if (!loaded || (loaded.loading && !loaded.component)) {
    return (
      <ComponentFrame
        {...frameHeightProps}
        node={node}
        className="component-node component-state"
        isVirtualRoot={isVirtualRoot}
        collapsed={collapsed}
        ariaLive="polite"
        onFocus={onFocus}
        onToggleCollapse={() => onToggleCollapse(node.id)}
        onCopyPath={onCopyPath}
        onEditComponent={onEditComponent}
        onOpenAgent={onOpenAgent}
      >
        {!collapsed ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Loading {name}…
            <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
          </>
        ) : null}
      </ComponentFrame>
    );
  }

  if (!loaded.component) {
    return (
      <ComponentFrame
        {...frameHeightProps}
        node={node}
        className="component-node component-state component-state--error"
        isVirtualRoot={isVirtualRoot}
        collapsed={collapsed}
        role="alert"
        onFocus={onFocus}
        onToggleCollapse={() => onToggleCollapse(node.id)}
        onCopyPath={onCopyPath}
        onEditComponent={onEditComponent}
        onOpenAgent={onOpenAgent}
      >
        {!collapsed ? (
          <>
            <strong>Could not load {name}</strong>
            <span>{loaded.error ?? "The compiled module has no component export."}</span>
            <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
          </>
        ) : null}
      </ComponentFrame>
    );
  }

  const Component = loaded.component;
  return (
    <ComponentFrame
      {...frameHeightProps}
      node={node}
      className="component-node component-node--local"
      isVirtualRoot={isVirtualRoot}
      collapsed={collapsed}
      onFocus={onFocus}
      onToggleCollapse={() => onToggleCollapse(node.id)}
      onCopyPath={onCopyPath}
      onEditComponent={onEditComponent}
      onOpenAgent={onOpenAgent}
    >
      {!collapsed ? (
        <>
          <LocalComponentErrorBoundary
            name={name}
            resetKey={`${node.id}:${loaded.revision}`}
          >
            <Component props={node.props} children={renderedChildren} host={localHost} />
          </LocalComponentErrorBoundary>
          {loaded.error ? (
            <span
              className="component-node__stale-warning"
              role="status"
              title={loaded.error}
            >
              Update failed; showing previous version
            </span>
          ) : null}
          <ComponentUpdatePolish batch={updateBatch} nodeId={node.id} />
        </>
      ) : null}
    </ComponentFrame>
  );
}

function useComponentUpdateBatch(
  tree: ResolvedComponentNode | null | undefined,
  identity: string | null | undefined,
  trusted: boolean | undefined,
  localComponents: ReadonlyMap<string, LoadedLocalComponent>,
): ComponentUpdateBatch | null {
  const previous = useRef<{
    identity: string;
    tree: ResolvedComponentNode;
    trusted: boolean;
    localComponentRevisions: ReadonlyMap<string, string>;
  } | null>(null);
  const generation = useRef(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [batch, setBatch] = useState<ComponentUpdateBatch | null>(null);

  useLayoutEffect(() => {
    if (!tree || !identity || trusted === undefined) {
      previous.current = null;
      setBatch(null);
      return;
    }

    const localComponentRevisions = new Map<string, string>();
    for (const [componentId, loaded] of localComponents) {
      if (loaded.component !== null) {
        localComponentRevisions.set(componentId, loaded.revision);
      }
    }
    const before = previous.current;
    previous.current = {
      identity,
      tree,
      trusted,
      localComponentRevisions,
    };
    if (
      before === null ||
      before.identity !== identity ||
      before.trusted !== trusted
    ) {
      if (clearTimer.current !== null) clearTimeout(clearTimer.current);
      clearTimer.current = null;
      setBatch(null);
      return;
    }

    const changedIds = changedComponentIds(
      before.tree,
      tree,
      before.localComponentRevisions,
      localComponentRevisions,
    );
    if (changedIds.length === 0) return;

    generation.current += 1;
    const delays = new Map(
      changedIds.map((id, index) => [
        id,
        updateStaggerMs(index, changedIds.length),
      ]),
    );
    setBatch({ generation: generation.current, delays });
    if (clearTimer.current !== null) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => {
      clearTimer.current = null;
      setBatch(null);
    }, 1_000);
  }, [identity, tree, trusted, localComponents]);

  useEffect(() => () => {
    if (clearTimer.current !== null) clearTimeout(clearTimer.current);
  }, []);

  return batch;
}

function DiagnosticItem({ diagnostic }: { diagnostic: Diagnostic }): ReactNode {
  const location = [
    diagnostic.file,
    diagnostic.line ? `line ${diagnostic.line}` : null,
    diagnostic.column ? `column ${diagnostic.column}` : null,
    diagnostic.path,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={`diagnostic diagnostic--${diagnostic.severity}`}>
      <span className="diagnostic__marker" aria-hidden="true" />
      <div>
        <div className="diagnostic__heading">
          <code>{diagnostic.code}</code>
          <strong>{diagnostic.message}</strong>
        </div>
        {location ? <span className="diagnostic__location">{location}</span> : null}
      </div>
    </li>
  );
}

function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const summary = [
    errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : null,
    warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <details className="diagnostics" open={errors > 0}>
      <summary>
        <span>Configuration diagnostics</span>
        <span className={errors ? "badge badge--error" : "badge badge--warning"}>{summary}</span>
      </summary>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <DiagnosticItem diagnostic={diagnostic} key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`} />
        ))}
      </ul>
    </details>
  );
}

function TrustPanel({
  snapshot,
  pending,
  onTrust,
}: {
  snapshot: ProjectSnapshot;
  pending: boolean;
  onTrust: () => void;
}): ReactNode {
  const localCode = hasLocalNode(snapshot.tree);
  return (
    <section className="trust-panel" aria-labelledby="trust-title">
      <div className="trust-panel__icon" aria-hidden="true">◇</div>
      <div className="trust-panel__content">
        <span className="eyebrow">Project trust</span>
        <h2 id="trust-title">Review this project before enabling capabilities</h2>
        <p>
          Passive layout and content are visible now. Trusting enables only the
          capabilities declared by this project.
        </p>
        <ul className="permission-list">
          {localCode ? <li>Load local component code</li> : null}
          {snapshot.requestedPermissions.map((permission) => (
            <li key={permission}>{PERMISSION_LABELS[permission]}</li>
          ))}
          {!localCode && snapshot.requestedPermissions.length === 0 ? (
            <li>No privileged capabilities requested</li>
          ) : null}
        </ul>
      </div>
      <button className="button button--primary" type="button" disabled={pending} onClick={onTrust}>
        {pending ? "Enabling…" : "Trust project"}
      </button>
    </section>
  );
}

function EmptyProject({
  pending,
  onChoose,
}: {
  pending: boolean;
  onChoose: () => void;
}): ReactNode {
  return (
    <main className="welcome">
      <div className="welcome__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="eyebrow">Local-first project cockpit</span>
      <h1>Put the project in front of you.</h1>
      <p>
        Choose a project folder to load its workflows, status, and tools into one
        focused workspace. Missing <code>dash-bored/</code> files are created for you.
      </p>
      <button className="button button--primary button--large" type="button" disabled={pending} onClick={onChoose}>
        {pending ? "Opening…" : "Choose a project"}
      </button>
    </main>
  );
}

function AgentPromptPanel({
  node,
  agentCommand,
  pending,
  onDismiss,
  onSend,
}: {
  node: ResolvedComponentNode;
  agentCommand: string;
  pending: boolean;
  onDismiss: () => void;
  onSend: (prompt: string) => Promise<void>;
}): ReactNode {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const locator = componentPath(node);

  async function submit(): Promise<void> {
    if (!prompt.trim() || pending) return;
    setError(null);
    try {
      await onSend(prompt.trim());
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  }

  return (
    <div className="agent-prompt">
      <p>
        Describe the change to this component. dash-bored adds the owning
        dashboard, component locator, and project instructions to the prompt.
      </p>
      <code className="agent-prompt__path" title={locator}>{locator}</code>
      <form className="agent-prompt__composer" onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
        <code className="agent-prompt__command">{agentCommand}</code>
        <span className="agent-prompt__quote" aria-hidden="true">&quot;</span>
        <textarea
          data-modal-autofocus
          aria-label="Wanted component change"
          placeholder="Change this component…"
          maxLength={12_000}
          value={prompt}
          disabled={pending}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <span className="agent-prompt__quote" aria-hidden="true">&quot;</span>
        <button className="button button--primary" type="submit" disabled={pending || !prompt.trim()}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
      <p className="agent-prompt__hint">Press Command/Ctrl-Enter to send.</p>
      {error ? <div className="agent-prompt__error" role="alert">{error}</div> : null}
      <footer className="editor-modal__actions">
        <button className="button button--quiet" type="button" disabled={pending} onClick={onDismiss}>Cancel</button>
      </footer>
    </div>
  );
}

function SettingsPanel({
  snapshot,
  appSettings,
  pendingAction,
  onSaveAgent,
  onReload,
  onTrust,
  onRevoke,
}: {
  snapshot: ProjectSnapshot | null;
  appSettings: AppSettings;
  pendingAction: string | null;
  onSaveAgent: (command: string) => void;
  onReload: () => void;
  onTrust: () => void;
  onRevoke: () => void;
}): ReactNode {
  const [agentDraft, setAgentDraft] = useState(appSettings.dashBoredAgent);
  useEffect(() => setAgentDraft(appSettings.dashBoredAgent), [appSettings.dashBoredAgent]);
  const normalizedAgentDraft = agentDraft.trim();
  const savingAgent = pendingAction === "save-agent";
  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div className="settings-page__heading">
        <span className="eyebrow">Application</span>
        <h1 id="settings-title">Settings</h1>
        <p>Manage the active dashboard and its local capabilities.</p>
      </div>
      <section className="settings-card" aria-labelledby="sidebar-settings-title">
        <div>
          <h2 id="sidebar-settings-title">Dashboard sidebar</h2>
          <p>The sidebar starts collapsed each time dash-bored opens. Expand it to see configured dashboard names.</p>
        </div>
        <span className="settings-value">Collapsed by default</span>
      </section>
      <section className="settings-card settings-card--agent" aria-labelledby="agent-settings-title">
        <div>
          <h2 id="agent-settings-title">Dashboard agent</h2>
          <p>Set the app-wide <code>DASH_BORED_AGENT</code> command used by every component’s Change with agent action.</p>
        </div>
        <form className="settings-agent" onSubmit={(event) => {
          event.preventDefault();
          if (normalizedAgentDraft) onSaveAgent(normalizedAgentDraft);
        }}>
          <label htmlFor="dash-bored-agent">DASH_BORED_AGENT</label>
          <div className="settings-agent__controls">
            <input
              id="dash-bored-agent"
              type="text"
              spellCheck={false}
              maxLength={1_024}
              value={agentDraft}
              disabled={savingAgent}
              onChange={(event) => setAgentDraft(event.target.value)}
            />
            <button
              className="button button--secondary"
              type="submit"
              disabled={savingAgent || !normalizedAgentDraft || normalizedAgentDraft === appSettings.dashBoredAgent}
            >
              {savingAgent ? "Saving…" : "Save"}
            </button>
          </div>
          <span>Example: <code>{normalizedAgentDraft || "codex exec"} &quot;Change this thing&quot;</code></span>
        </form>
      </section>
      <section className="settings-card" aria-labelledby="project-settings-title">
        <div className="settings-card__project">
          <h2 id="project-settings-title">Active dashboard</h2>
          {snapshot?.projectRoot ? (
            <>
              <strong>{snapshot.dashboardName?.trim() || basename(snapshot.projectRoot)}</strong>
              <code title={snapshot.projectRoot}>{snapshot.projectRoot}</code>
            </>
          ) : (
            <p>No dashboard is currently open.</p>
          )}
        </div>
        {snapshot?.projectRoot ? (
          <div className="settings-card__actions">
            <button className="button button--quiet" type="button" disabled={pendingAction !== null} onClick={onReload}>
              {pendingAction === "reload" ? "Reloading…" : "Reload dashboard"}
            </button>
            {snapshot.trusted ? (
              <button className="button button--danger" type="button" disabled={pendingAction !== null} onClick={onRevoke}>
                {pendingAction === "revoke" ? "Revoking…" : "Revoke trust"}
              </button>
            ) : (
              <button className="button button--primary" type="button" disabled={pendingAction !== null || snapshot.tree === null} onClick={onTrust}>
                {pendingAction === "trust" ? "Enabling…" : "Trust dashboard"}
              </button>
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>({ dashBoredAgent: "codex exec" });
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const nextActionNoticeId = useRef(0);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [expandedProjectOutlines, setExpandedProjectOutlines] = useState<Record<string, boolean>>({});
  const [projectOutlines, setProjectOutlines] = useState<Record<string, ProjectOutlineState>>({});
  const [activeView, setActiveView] = useState<AppView>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [virtualRoots, setVirtualRoots] = useState<Record<string, string | null>>({});
  const [collapsedDashboardPath, setCollapsedDashboardPath] = useState<string | null>(null);
  const [collapsedComponentIds, setCollapsedComponentIds] = useState<Set<string>>(new Set());
  const [splitRatioDashboardPath, setSplitRatioDashboardPath] = useState<string | null>(null);
  const [splitRatioOverrides, setSplitRatioOverrides] = useState<SplitRatioOverrides>({});
  const [componentHeightDashboardPath, setComponentHeightDashboardPath] = useState<string | null>(null);
  const [componentHeightOverrides, setComponentHeightOverrides] = useState<ComponentHeightOverrides>({});
  const compositionInteraction = useCompositionInteractionController();
  const {
    libraryOpen: componentLibraryOpen,
    dragging: compositionDrag,
    pointer: compositionPointer,
    selectedTarget: compositionTarget,
    dialog: compositionDialog,
    removePath: compositionRemovePath,
  } = compositionInteraction;
  const [compositionSource, setCompositionSource] = useState<DashboardCompositionSource | null>(null);
  const [editSession, setEditSession] = useState<DashboardEditSession | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState<{
    message: string;
    continueAction: () => void;
  } | null>(null);
  const [deletionDialog, setDeletionDialog] = useState<{
    project: ProjectListItem;
    preview: ProjectDeletionPreview;
    removeFiles: boolean;
  } | null>(null);
  const compositionPointerFrame = useRef<number | null>(null);
  const pendingCompositionPointer = useRef<{
    payload: CompositionDragPayload;
    point: ComponentPointerDragPoint;
  } | null>(null);
  const [agentDialog, setAgentDialog] = useState<ResolvedComponentNode | null>(null);
  const localComponents = useLocalComponents(
    snapshot?.components ?? [],
    snapshot?.configPath ?? null,
  );
  const componentUpdateBatch = useComponentUpdateBatch(
    snapshot?.tree,
    snapshot?.configPath,
    snapshot?.trusted,
    localComponents,
  );
  const actionRegistry = useMemo(() => new ActionRegistry(), []);
  const componentActions = useSyncExternalStore(
    actionRegistry.subscribe,
    actionRegistry.getSnapshot,
  );
  const actionsByIdRef = useRef<ReadonlyMap<string, PaletteAction>>(new Map());
  const actionExecutor = useMemo(
    () => new ActionExecutor((id) => actionsByIdRef.current.get(id)),
    [],
  );
  const runningActionIds = useSyncExternalStore(
    actionExecutor.subscribe,
    actionExecutor.getSnapshot,
  );

  useEffect(() => () => {
    if (compositionPointerFrame.current !== null) {
      cancelAnimationFrame(compositionPointerFrame.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = host.subscribe((event) => {
      if (!active) return;
      if (event.type === "snapshot") {
        setSnapshot(event.snapshot);
        setProjects((current) => rememberProject(current, event.snapshot));
      } else if (event.type === "process") {
        setSnapshot((current) =>
          current ? replaceProcess(current, event.process) : current,
        );
      } else {
        setPaletteOpen(true);
      }
    });

    void Promise.all([host.getSnapshot(), host.listProjects(), host.getAppSettings()])
      .then(([initialSnapshot, initialProjects, initialSettings]) => {
        if (!active) return;
        setSnapshot(initialSnapshot);
        setProjects(rememberProject(initialProjects, initialSnapshot));
        setAppSettings(initialSettings);
      })
      .catch((error: unknown) => {
        if (active) setActionError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const snapshotConfigPath = snapshot?.configPath;
    if (!snapshotConfigPath) return;
    setProjectOutlines((current) => ({
      ...current,
      [snapshotConfigPath]: {
        tree: snapshot.tree,
        loading: false,
        error: outlineError(snapshot),
      },
    }));
  }, [snapshot?.configPath, snapshot?.revision, snapshot?.tree, snapshot?.diagnostics]);

  useEffect(() => {
    if (!editSession) return;
    const source = JSON.stringify(editSession.draft);
    let cancelled = false;
    const timer = setTimeout(() => {
      void host.validateDashboardDraft(editSession.draft, editSession.configPath)
        .then((validation) => {
          if (cancelled) return;
          setEditSession((current) =>
            current && JSON.stringify(current.draft) === source
              ? { ...current, validation }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!cancelled) setActionError(errorMessage(error));
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editSession?.draft]);

  useEffect(() => {
    function openFromKeyboard(event: globalThis.KeyboardEvent): void {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, []);

  useEffect(() => {
    if (!actionNotice) return;
    const noticeId = actionNotice.id;
    const timeout = window.setTimeout(() => {
      setActionNotice((current) => current?.id === noticeId ? null : current);
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [actionNotice?.id]);

  const processes = useMemo(
    () => new Map(snapshot?.processes.map((process) => [process.id, process]) ?? []),
    [snapshot?.processes],
  );

  async function perform(name: string, action: () => Promise<unknown>): Promise<void> {
    setPendingAction(name);
    setActionError(null);
    setActionNotice(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  function showActionNotice(message: string): void {
    nextActionNoticeId.current += 1;
    setActionNotice({ id: nextActionNoticeId.current, message });
  }

  function resetCompositionUi(): void {
    compositionInteraction.reset();
    setCompositionSource(null);
  }

  function editSessionDirty(): boolean {
    return Boolean(editSession && JSON.stringify(editSession.original) !== JSON.stringify(editSession.draft));
  }

  function requireDiscard(message: string, continueAction: () => void): boolean {
    if (!editSessionDirty()) {
      setEditSession(null);
      resetCompositionUi();
      return true;
    }
    setDiscardConfirmation({ message, continueAction });
    return false;
  }

  async function chooseDashboard(): Promise<void> {
    await perform("choose", async () => {
      const nextSnapshot = await host.chooseProject();
      setProjects(rememberProject(await host.listProjects(), nextSnapshot));
      if (nextSnapshot.projectRoot) setActiveView("dashboard");
    });
  }

  async function addDashboard(): Promise<void> {
    if (editSession && !requireDiscard(
      "Discard the unsaved dashboard changes and add another dashboard?",
      () => void chooseDashboard(),
    )) return;
    await chooseDashboard();
  }

  async function openSelectedProject(project: ProjectListItem): Promise<void> {
    if (snapshot?.configPath === project.configPath) {
      setActiveView("dashboard");
      return;
    }
    await perform(`open:${dashboardKey(project)}`, async () => {
      await host.openProject(project);
      setActiveView("dashboard");
    });
  }

  async function selectProject(project: ProjectListItem): Promise<void> {
    if (editSession && editSession.configPath !== project.configPath && !requireDiscard(
      "Discard the unsaved dashboard changes and switch projects?",
      () => void openSelectedProject(project),
    )) return;
    await openSelectedProject(project);
  }

  function toggleProjectOutline(project: ProjectListItem): void {
    const key = dashboardKey(project);
    const closing = expandedProjectOutlines[key] === true;
    setExpandedProjectOutlines((current) => ({ ...current, [key]: !closing }));
    if (closing || snapshot?.configPath === project.configPath) return;

    setProjectOutlines((current) => ({
      ...current,
      [key]: {
        tree: current[key]?.tree ?? null,
        loading: true,
        error: null,
      },
    }));
    void host.getProjectOutline(project)
      .then((outline) => {
        setProjectOutlines((current) => ({
          ...current,
          [key]: {
            tree: outline.tree,
            loading: false,
            error: outlineError(outline),
          },
        }));
      })
      .catch((error: unknown) => {
        setProjectOutlines((current) => ({
          ...current,
          [key]: {
            tree: null,
            loading: false,
            error: errorMessage(error),
          },
        }));
      });
  }

  async function openDeletionDialog(
    project: ProjectListItem,
    skipDiscard = false,
  ): Promise<void> {
    if (
      !skipDiscard &&
      editSession?.configPath === project.configPath &&
      !requireDiscard(
        "Discard the unsaved dashboard changes and remove this dashboard?",
        () => void openDeletionDialog(project, true),
      )
    ) return;

    await perform(`preview-delete:${dashboardKey(project)}`, async () => {
      const preview = await host.getProjectDeletionPreview(project);
      setDeletionDialog({ project, preview, removeFiles: false });
    });
  }

  async function confirmDeletion(): Promise<void> {
    if (!deletionDialog) return;
    const request = deletionDialog;
    const wasActive = snapshot?.configPath === request.project.configPath;
    const activeProjectIndex = projects.findIndex(
      (project) => project.configPath === request.project.configPath,
    );
    setDeletionDialog(null);
    setPendingAction(`delete:${dashboardKey(request.project)}`);
    setActionError(null);
    try {
      await host.deleteProject(request.project, request.removeFiles);
      const remaining = await host.listProjects();
      setProjects(remaining);
      setEditSession((current) =>
        current?.configPath === request.project.configPath ? null : current,
      );
      if (editSession?.configPath === request.project.configPath) resetCompositionUi();
      setVirtualRoots((current) => {
        if (!Object.hasOwn(current, request.project.configPath)) return current;
        const next = { ...current };
        delete next[request.project.configPath];
        return next;
      });
      setExpandedProjectOutlines((current) => {
        if (!Object.hasOwn(current, request.project.configPath)) return current;
        const next = { ...current };
        delete next[request.project.configPath];
        return next;
      });
      setProjectOutlines((current) => {
        if (!Object.hasOwn(current, request.project.configPath)) return current;
        const next = { ...current };
        delete next[request.project.configPath];
        return next;
      });
      try {
        window.localStorage.removeItem(virtualRootStorageKey(request.project.configPath));
        window.localStorage.removeItem(splitRatioOverridesStorageKey(request.project.configPath));
        window.localStorage.removeItem(componentHeightOverridesStorageKey(request.project.configPath));
      } catch {
        // The in-memory focus, split, and component-height state has already been cleared.
      }

      if (wasActive) {
        setActiveView("dashboard");
        const nextIndex = Math.min(
          Math.max(activeProjectIndex, 0),
          Math.max(remaining.length - 1, 0),
        );
        const nextProject = remaining[nextIndex];
        if (nextProject) await host.openProject(nextProject);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function loadCompositionSource(): Promise<void> {
    if (!snapshot?.projectRoot || !snapshot.configPath) return;
    const focusedSource = virtualRoot?.node.sourceConfigPath;
    if (!focusedSource || focusedSource === snapshot.configPath) {
      setCompositionSource(null);
      return;
    }
    const request = {
      projectRoot: snapshot.projectRoot,
      activeDashboardPath: snapshot.configPath,
      focusedSourcePath: focusedSource,
      snapshotRevision: snapshot.revision,
      configPath: focusedSource,
    };
    setCompositionSource(null);
    try {
      const source = await host.getDashboardConfigSource(focusedSource);
      if (source.configPath !== request.configPath) return;
      setCompositionSource({
        ...request,
        config: source.config,
        componentCatalog: source.componentCatalog,
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function toggleCompositionLibrary(): void {
    compositionInteraction.toggleLibrary();
  }

  async function ensureCurrentDashboardEdit(): Promise<DashboardEditSession | null> {
    if (!snapshot?.projectRoot || !snapshot.configPath) return null;
    if (editSession?.projectRoot === snapshot.projectRoot) {
      return editSession;
    }
    if (editSession) {
      setActionError("Finish the current dashboard draft before composing another dashboard.");
      return null;
    }

    let loaded: DashboardEditSession | null = null;
    await perform(`edit:${snapshot.configPath}`, async () => {
      const focusedSource = virtualRoot?.node.sourceConfigPath;
      const source = await host.getDashboardConfigSource(focusedSource);
      const validation = await host.validateDashboardDraft(source.config, source.configPath);
      loaded = {
        projectRoot: snapshot.projectRoot!,
        configPath: source.configPath,
        componentCatalog: source.componentCatalog,
        original: structuredClone(source.config),
        draft: structuredClone(source.config),
        expectedConfigRevision: source.configRevision,
        validation,
      };
      setActiveView("dashboard");
      setEditSession(loaded);
    });
    return loaded;
  }

  function cancelDashboardEdit(): void {
    if (!editSession) return;
    if (requireDiscard("Discard the unsaved dashboard changes and exit edit mode?", () => undefined)) {
      setEditSession(null);
      resetCompositionUi();
    }
  }

  function showSettings(): void {
    if (editSession && !requireDiscard(
      "Discard the unsaved dashboard changes and open settings?",
      () => setActiveView("settings"),
    )) return;
    setActiveView("settings");
  }

  function saveAgentSetting(command: string): void {
    void perform("save-agent", async () => {
      const updated = await host.updateAppSettings({ dashBoredAgent: command });
      setAppSettings(updated);
      showActionNotice(`DASH_BORED_AGENT is now ${updated.dashBoredAgent}.`);
    });
  }

  async function copyComponentPath(node: ResolvedComponentNode): Promise<void> {
    setActionError(null);
    setActionNotice(null);
    const locator = componentPath(node);
    try {
      await writeClipboardText(locator);
      showActionNotice(`Copied ${locator}`);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function runComponentAgent(node: ResolvedComponentNode, prompt: string): Promise<void> {
    const action = `component-agent:${node.id}`;
    setPendingAction(action);
    setActionError(null);
    setActionNotice(null);
    try {
      const launched = await host.runComponentAgent({ nodeId: node.id, prompt });
      setAgentDialog(null);
      showActionNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    } finally {
      setPendingAction(null);
    }
  }

  async function runComponentCreationAgent(
    configPath: string,
    target: InsertionTarget,
    prompt: string,
  ): Promise<void> {
    setPendingAction("component-agent:create");
    setActionError(null);
    setActionNotice(null);
    try {
      const launched = await host.runComponentCreationAgent({ configPath, target, prompt });
      setEditSession(null);
      resetCompositionUi();
      showActionNotice(`Started ${launched.command} for ${launched.componentPath}.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  function requestComponentCreationAgent(target: InsertionTarget, prompt: string): void {
    if (!editSession || pendingAction !== null) return;
    const configPath = editSession.configPath;
    const launch = (): void => {
      void runComponentCreationAgent(configPath, target, prompt);
    };
    if (editSessionDirty()) {
      setDiscardConfirmation({
        message: "Discard the dashboard draft and ask the configured agent to build this component?",
        continueAction: launch,
      });
      return;
    }
    launch();
  }

  async function saveDashboardDraft(): Promise<void> {
    if (!editSession) return;
    setSavingDraft(true);
    setActionError(null);
    try {
      await host.saveDashboardConfig(
        editSession.draft,
        editSession.expectedConfigRevision,
        editSession.configPath,
      );
      setEditSession(null);
      resetCompositionUi();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSavingDraft(false);
    }
  }

  const editingActiveProject = Boolean(editSession && editSession.projectRoot === snapshot?.projectRoot);
  const draftDirty = Boolean(editSession && editSessionDirty());
  const draftValid = Boolean(editSession &&
    editSession?.validation.diagnostics.every((item) => item.severity !== "error"),
  );
  const applicationActions = buildApplicationActions({
    snapshot,
    projects,
    activeView,
    sidebarExpanded,
    pendingAction,
    editing: editingActiveProject,
    draftDirty,
    draftValid,
    savingDraft,
    callbacks: {
      showDashboard: () => setActiveView("dashboard"),
      showSettings,
      toggleSidebar: () => setSidebarExpanded((expanded) => !expanded),
      addDashboard,
      openProject: selectProject,
      editDashboard: toggleCompositionLibrary,
      saveDashboard: () => saveDashboardDraft(),
      cancelDashboard: cancelDashboardEdit,
      reloadProject: () => perform("reload", host.reloadProject),
      trustProject: () => perform("trust", host.trustProject),
      revokeTrust: () => perform("revoke", host.revokeTrust),
      runProcessQuickAction: async (nodeId) => {
        await host.runProcessQuickAction(nodeId);
      },
      stopProcess: async (nodeId) => {
        await host.stopProcess(nodeId);
      },
    },
  });
  const dashboardPath = snapshot?.configPath ?? null;
  const storedVirtualRoot = dashboardPath ? virtualRoots[dashboardPath] : null;
  const activeCollapsedComponentIds = collapsedDashboardPath === dashboardPath
    ? collapsedComponentIds
    : EMPTY_COLLAPSED_COMPONENT_IDS;
  const activeSplitRatioOverrides = splitRatioDashboardPath === dashboardPath
    ? splitRatioOverrides
    : EMPTY_SPLIT_RATIO_OVERRIDES;
  const activeComponentHeightOverrides = componentHeightDashboardPath === dashboardPath
    ? componentHeightOverrides
    : EMPTY_COMPONENT_HEIGHT_OVERRIDES;
  const virtualRoot = snapshot?.tree
    ? resolveVirtualRoot(snapshot.tree, storedVirtualRoot ?? null)
    : null;
  const compositionPreviewTree = useMemo(() => {
    if (!snapshot?.tree) return null;
    const source = compositionSource
      && compositionSource.projectRoot === snapshot.projectRoot
      && compositionSource.activeDashboardPath === snapshot.configPath
      && compositionSource.focusedSourcePath === virtualRoot?.node.sourceConfigPath
      && compositionSource.snapshotRevision === snapshot.revision
      ? compositionSource
      : null;
    if (!editSession) {
      if (!source || source.configPath === snapshot.configPath) return snapshot.tree;
      const template = findResolvedConfigRoot(snapshot.tree, source.configPath);
      return template
        ? buildCompositionPreviewTree(
            source.config,
            template,
            source.componentCatalog,
            source.configPath,
            linkedComponentIdNamespace(template, source.config.root),
          )
        : null;
    }
    if (!editSession.configPath) return null;
    const template = editSession.configPath === snapshot.configPath
      ? snapshot.tree
      : findResolvedConfigRoot(snapshot.tree, editSession.configPath);
    return template
      ? buildCompositionPreviewTree(
          editSession.draft,
          template,
          editSession.componentCatalog,
          editSession.configPath,
          editSession.configPath === snapshot.configPath
            ? undefined
            : linkedComponentIdNamespace(template, editSession.draft.root),
        )
      : null;
  }, [
    compositionSource,
    editSession,
    snapshot?.configPath,
    snapshot?.projectRoot,
    snapshot?.tree,
    virtualRoot?.node.sourceConfigPath,
  ]);
  const compositionVirtualRoot = compositionPreviewTree
    ? resolveVirtualRoot(compositionPreviewTree, storedVirtualRoot ?? null)
    : null;
  const activeCompositionSource = compositionSource
    && compositionSource.projectRoot === snapshot?.projectRoot
    && compositionSource.activeDashboardPath === snapshot?.configPath
    && compositionSource.focusedSourcePath === virtualRoot?.node.sourceConfigPath
    && compositionSource.snapshotRevision === snapshot?.revision
    ? compositionSource
    : null;
  const compositionConfig = editSession
    ? editSession.draft
    : activeCompositionSource?.config ?? snapshot?.config ?? null;
  const compositionCatalog = editSession
    ? editSession.componentCatalog
    : activeCompositionSource?.componentCatalog ?? snapshot?.componentCatalog ?? [];
  const compositionSourcePending = Boolean(
    componentLibraryOpen
    && !editSession
    && virtualRoot?.node.sourceConfigPath
    && snapshot?.configPath
    && virtualRoot.node.sourceConfigPath !== snapshot.configPath
    && !activeCompositionSource,
  );
  const editingComposition = Boolean(editSession && editingActiveProject && compositionPreviewTree);

  function compositionSourceIsReady(): boolean {
    if (!compositionSourcePending) return true;
    setActionError("Loading the focused dashboard bundle before composing.");
    return false;
  }

  useEffect(() => {
    if (!dashboardPath) {
      setCollapsedDashboardPath(null);
      setCollapsedComponentIds(new Set());
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(collapsedComponentsStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable in hardened webviews; collapse state remains session-only.
    }
    setCollapsedComponentIds(parseCollapsedComponentIds(saved));
    setCollapsedDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || collapsedDashboardPath !== dashboardPath) return;
    try {
      window.localStorage.setItem(
        collapsedComponentsStorageKey(dashboardPath),
        serializeCollapsedComponentIds(collapsedComponentIds),
      );
    } catch {
      // Collapse state remains available for this session when persistence is unavailable.
    }
  }, [collapsedComponentIds, collapsedDashboardPath, dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || collapsedDashboardPath !== dashboardPath || !snapshot?.tree) return;
    const validIds = collectComponentNodeIds(snapshot.tree);
    setCollapsedComponentIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, [collapsedDashboardPath, dashboardPath, snapshot?.tree]);

  useEffect(() => {
    if (!dashboardPath) {
      setSplitRatioDashboardPath(null);
      setSplitRatioOverrides({});
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(splitRatioOverridesStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable; split overrides remain session-only.
    }
    setSplitRatioOverrides(parseSplitRatioOverrides(saved));
    setSplitRatioDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || splitRatioDashboardPath !== dashboardPath) return;
    try {
      window.localStorage.setItem(
        splitRatioOverridesStorageKey(dashboardPath),
        serializeSplitRatioOverrides(splitRatioOverrides),
      );
    } catch {
      // Split overrides remain available for this session when persistence is unavailable.
    }
  }, [dashboardPath, splitRatioDashboardPath, splitRatioOverrides]);

  useEffect(() => {
    if (!dashboardPath || splitRatioDashboardPath !== dashboardPath || !snapshot?.tree) return;
    setSplitRatioOverrides((current) => {
      const next = pruneSplitRatioOverrides(current, snapshot.tree!);
      return serializeSplitRatioOverrides(next) === serializeSplitRatioOverrides(current)
        ? current
        : next;
    });
  }, [dashboardPath, snapshot?.tree, splitRatioDashboardPath]);

  useEffect(() => {
    if (!dashboardPath) {
      setComponentHeightDashboardPath(null);
      setComponentHeightOverrides({});
      return;
    }
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(componentHeightOverridesStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable; height caps remain session-only.
    }
    setComponentHeightOverrides(parseComponentHeightOverrides(saved));
    setComponentHeightDashboardPath(dashboardPath);
  }, [dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || componentHeightDashboardPath !== dashboardPath) return;
    try {
      window.localStorage.setItem(
        componentHeightOverridesStorageKey(dashboardPath),
        serializeComponentHeightOverrides(componentHeightOverrides),
      );
    } catch {
      // Height caps remain available for this session when persistence is unavailable.
    }
  }, [componentHeightDashboardPath, componentHeightOverrides, dashboardPath]);

  useEffect(() => {
    if (!dashboardPath || componentHeightDashboardPath !== dashboardPath || !snapshot?.tree) return;
    setComponentHeightOverrides((current) => {
      const next = pruneComponentHeightOverrides(current, snapshot.tree!);
      return serializeComponentHeightOverrides(next) === serializeComponentHeightOverrides(current)
        ? current
        : next;
    });
  }, [componentHeightDashboardPath, dashboardPath, snapshot?.tree]);

  useEffect(() => {
    if (!dashboardPath || Object.hasOwn(virtualRoots, dashboardPath)) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(virtualRootStorageKey(dashboardPath));
    } catch {
      // Local storage can be unavailable in hardened webviews; focus still works for this session.
    }
    setVirtualRoots((current) => Object.hasOwn(current, dashboardPath)
      ? current
      : { ...current, [dashboardPath]: saved });
  }, [dashboardPath, virtualRoots]);

  useEffect(() => {
    if (!dashboardPath || !snapshot?.tree || !storedVirtualRoot) return;
    const resolved = resolveVirtualRoot(snapshot.tree, storedVirtualRoot);
    if (resolved.node.id === storedVirtualRoot) return;
    setVirtualRoots((current) => ({ ...current, [dashboardPath]: null }));
    try {
      window.localStorage.removeItem(virtualRootStorageKey(dashboardPath));
    } catch {
      // See the read path above.
    }
  }, [dashboardPath, snapshot?.tree, storedVirtualRoot]);

  function storeVirtualRoot(targetDashboardPath: string, nodeId: string): void {
    setVirtualRoots((current) => ({ ...current, [targetDashboardPath]: nodeId }));
    try {
      window.localStorage.setItem(virtualRootStorageKey(targetDashboardPath), nodeId);
    } catch {
      // Session state remains usable when persistence is unavailable.
    }
  }

  function expandComponent(targetDashboardPath: string, nodeId: string): void {
    if (collapsedDashboardPath === targetDashboardPath) {
      setCollapsedComponentIds((current) => {
        if (!current.has(nodeId)) return current;
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(collapsedComponentsStorageKey(targetDashboardPath));
      const ids = parseCollapsedComponentIds(saved);
      if (!ids.delete(nodeId)) return;
      window.localStorage.setItem(
        collapsedComponentsStorageKey(targetDashboardPath),
        serializeCollapsedComponentIds(ids),
      );
    } catch {
      // The target dashboard will still render the focused node when its state is unavailable.
    }
  }

  function toggleComponentCollapse(nodeId: string): void {
    if (!dashboardPath || collapsedDashboardPath !== dashboardPath) return;
    setCollapsedComponentIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function updateSplitRatio(
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
  ): void {
    if (!dashboardPath || splitRatioDashboardPath !== dashboardPath) return;
    const normalizedDefault = normalizeSplitRatio(defaultRatio);
    setSplitRatioOverrides((current) => {
      if (ratio === null || splitRatioMatches(ratio, normalizedDefault)) {
        const next = Object.fromEntries(Object.entries(current));
        if (!Object.hasOwn(next, branchKey)) return current;
        delete next[branchKey];
        return next;
      }
      const normalizedRatio = normalizeSplitRatio(ratio);
      const existing = current[branchKey];
      if (
        existing &&
        splitRatioMatches(existing.ratio, normalizedRatio) &&
        splitRatioMatches(existing.defaultRatio, normalizedDefault)
      ) return current;
      return {
        ...current,
        [branchKey]: {
          ratio: normalizedRatio,
          defaultRatio: normalizedDefault,
        },
      };
    });
  }

  function updateComponentHeight(nodeId: string, height: number | null): void {
    if (!dashboardPath) return;
    setComponentHeightOverrides((current) => {
      const next = Object.fromEntries(Object.entries(current));
      const normalized = normalizeComponentHeight(height);
      if (height === null || normalized === undefined) {
        if (!Object.hasOwn(next, nodeId)) return current;
        delete next[nodeId];
        return next;
      }
      if (next[nodeId] === normalized) return current;
      next[nodeId] = normalized;
      return next;
    });
  }

  function compositionPathForNode(node: ResolvedComponentNode): NodePath | null {
    if (!compositionConfig) return null;
    const owningConfigPath = editSession?.configPath
      ?? activeCompositionSource?.configPath
      ?? snapshot?.configPath;
    if (owningConfigPath && node.sourceConfigPath === owningConfigPath && node.sourcePath) {
      const sourcePath = nodePathFromSourcePath(node.sourcePath);
      if (sourcePath) return sourcePath;
    }
    try {
      return nodePathById(compositionConfig.root, node.id);
    } catch {
      return null;
    }
  }

  function decorateCompositionInsertionTarget(
    target: InsertionTarget,
    manifest: ComponentCatalogItem["manifest"],
    childCount: number,
  ): InsertionTarget {
    const metadata = manifest ? defaultChildMetadata(manifest, target.placement.type === "managed"
      ? target.placement.index
      : childCount) : {};
    return Object.keys(metadata).length === 0
      ? target
      : { ...target, placement: { ...target.placement, metadata } };
  }

  function compositionDropZonesForNode(
    node: ResolvedComponentNode,
    payload: CompositionDragPayload | null = compositionDrag,
  ): CompositionDropZone[] {
    if (!compositionConfig) return [];
    const path = compositionPathForNode(node);
    if (!path) return [];
    try {
      if (path.length === 0) {
        const rawRoot = nodeAtPath(compositionConfig.root, path);
        if (rawRoot.children) return [];
        const manifest = catalogManifest(compositionCatalog, rawRoot.component);
        return compatibleCompositionDropZones(
          deriveInsertionTargets({
            target: rawRoot,
            manifest,
            parentPath: path,
            currentChildCount: childEdges(rawRoot.children).length,
          }).map((target) => {
            const decorated = decorateCompositionInsertionTarget(target, manifest, 0);
            return {
              id: compositionTargetId(decorated),
              label: contextualInsertionLabel(rawRoot, decorated, compositionCatalog),
              side: "inside" as const,
              target: decorated,
            };
          }),
          payload,
          compositionTargetIsValid,
        );
      }
      const parentPath = path.slice(0, -1);
      const targetChildPath = path.at(-1);
      if (!targetChildPath) return [];
      const parent = nodeAtPath(compositionConfig.root, parentPath);
      const manifest = catalogManifest(compositionCatalog, parent.component);
      const childCount = childEdges(parent.children).length;
      return compatibleCompositionDropZones(
        deriveInsertionTargets({
          target: parent,
          manifest,
          parentPath,
          targetChildPath,
          currentChildCount: childCount,
        }).map((target) => {
          const decorated = decorateCompositionInsertionTarget(target, manifest, childCount);
          return {
            id: compositionTargetId(decorated),
            label: contextualInsertionLabel(parent, decorated, compositionCatalog),
            side: compositionDropZoneSide(decorated, targetChildPath),
            target: decorated,
          };
        }),
        payload,
        compositionTargetIsValid,
      );
    } catch {
      return [];
    }
  }

  function compositionPointerDropZone(
    node: ResolvedComponentNode,
    xRatio: number,
    yRatio: number,
    payload: CompositionDragPayload | null = compositionDrag,
  ): CompositionDropZone | null {
    if (
      !Number.isFinite(xRatio)
      || !Number.isFinite(yRatio)
      || xRatio < 0
      || xRatio > 1
      || yRatio < 0
      || yRatio > 1
    ) return null;
    const zones = compositionDropZonesForNode(node, payload);
    const inside = zones.find((zone) => zone.side === "inside");
    if (inside) return inside;
    const distance = (zone: CompositionDropZone): number => {
      if (zone.side === "left") return xRatio;
      if (zone.side === "right") return 1 - xRatio;
      if (zone.side === "top") return yRatio;
      if (zone.side === "bottom") return 1 - yRatio;
      return Number.POSITIVE_INFINITY;
    };
    return [...zones].sort((left, right) => distance(left) - distance(right))[0] ?? null;
  }

  function compositionPointerTargetAt(
    point: ComponentPointerDragPoint,
    payload: CompositionDragPayload,
  ): { node: ResolvedComponentNode; zone: CompositionDropZone } | null {
    if (!compositionPreviewTree) return null;
    const eventTarget = document.elementFromPoint(point.clientX, point.clientY);
    if (!(eventTarget instanceof globalThis.Element)) return null;
    if (eventTarget.closest("[data-composition-controls]")) return null;
    const nodeElement = eventTarget.closest<HTMLElement>("[data-node-id]");
    const nodeId = nodeElement?.dataset.nodeId;
    if (!nodeId || !nodeElement) return null;
    const node = resolvedNodeById(compositionPreviewTree, nodeId);
    if (!node) return null;
    const rect = nodeElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const zone = compositionPointerDropZone(
      node,
      (point.clientX - rect.left) / rect.width,
      (point.clientY - rect.top) / rect.height,
      payload,
    );
    return zone && compositionTargetIsValid(zone.target, payload) ? { node, zone } : null;
  }

  function updateCompositionPointerDrag(
    payload: CompositionDragPayload,
    point: ComponentPointerDragPoint,
  ): void {
    const target = compositionPointerTargetAt(point, payload);
    compositionInteraction.updatePointer(target ? {
      nodeId: target.node.id,
      zoneId: target.zone.id,
      clientX: point.clientX,
      clientY: point.clientY,
    } : null);
  }

  function scheduleCompositionPointerDrag(
    payload: CompositionDragPayload,
    point: ComponentPointerDragPoint,
  ): void {
    pendingCompositionPointer.current = { payload, point };
    if (compositionPointerFrame.current !== null) return;
    compositionPointerFrame.current = requestAnimationFrame(() => {
      compositionPointerFrame.current = null;
      const pending = pendingCompositionPointer.current;
      pendingCompositionPointer.current = null;
      if (pending) updateCompositionPointerDrag(pending.payload, pending.point);
    });
  }

  function clearPendingCompositionPointer(): void {
    pendingCompositionPointer.current = null;
    if (compositionPointerFrame.current !== null) {
      cancelAnimationFrame(compositionPointerFrame.current);
      compositionPointerFrame.current = null;
    }
  }

  function dropCompositionPointer(
    payload: CompositionDragPayload,
    point: ComponentPointerDragPoint,
  ): void {
    const target = compositionPointerTargetAt(point, payload);
    clearPendingCompositionPointer();
    compositionInteraction.updatePointer(null);
    if (target) {
      handleCompositionDrop(target.zone.target, payload);
      return;
    }
    const removalTarget = document.elementFromPoint(point.clientX, point.clientY)
      ?.closest("[data-composition-removal-target]");
    if (payload.type === "node" && removalTarget) {
      void removeCompositionNode(payload.path);
    }
  }

  function handleCompositionPointerDragMove(
    reference: string,
    point: ComponentPointerDragPoint,
  ): void {
    scheduleCompositionPointerDrag({ type: "component", reference }, point);
  }

  function handleCompositionPointerDrop(
    reference: string,
    point: ComponentPointerDragPoint,
  ): void {
    dropCompositionPointer({ type: "component", reference }, point);
  }

  function compositionTargetIsValid(
    target: CompositionTarget,
    payload: CompositionDragPayload,
  ): boolean {
    if (!compositionConfig) return false;
    return planCompositionOperation({
      config: compositionConfig,
      catalog: compositionCatalog,
      payload,
      target,
    }).status === "planned";
  }

  function defaultCompositionTarget(): CompositionTarget | null {
    if (!compositionConfig) return null;
    const manifest = catalogManifest(compositionCatalog, compositionConfig.root.component);
    const insertion = deriveInsertionTargets({
      target: compositionConfig.root,
      manifest,
      parentPath: [],
      currentChildCount: childEdges(compositionConfig.root.children).length,
    })[0];
    if (!insertion) return { type: "root-replacement", path: [] };
    const metadata = manifest ? defaultChildMetadata(manifest, childEdges(compositionConfig.root.children).length) : {};
    return Object.keys(metadata).length === 0
      ? insertion
      : { ...insertion, placement: { ...insertion.placement, metadata } };
  }

  async function openCompositionDialog(
    target: CompositionTarget,
    reference?: string,
  ): Promise<void> {
    if (!compositionSourceIsReady()) return;
    if (!compositionConfig || !snapshot?.tree) return;
    const payload: CompositionDragPayload = {
      type: "component",
      reference: reference ?? "",
    };
    if (!reference || !compositionTargetIsValid(target, payload)) {
      setActionError("Choose a valid component and insertion target before composing.");
      return;
    }
    const session = await ensureCurrentDashboardEdit();
    if (!session) return;
      compositionInteraction.showDialog(isRootCompositionTarget(target)
        ? { mode: "replace", reference }
        : { mode: "add", target, reference });
  }

  function handleCompositionInsert(entry: ComponentCatalogItem): void {
    if (!compositionSourceIsReady()) return;
    const target = compositionTarget ?? defaultCompositionTarget();
    if (!target) {
      setActionError("No dashboard insertion target is available.");
      return;
    }
    void openCompositionDialog(target, entry.reference);
  }

  async function handleCompositionAgent(description: string): Promise<void> {
    if (!compositionSourceIsReady()) return;
    let target = compositionTarget ?? defaultCompositionTarget();
    if (!target || isRootCompositionTarget(target)) {
      const fallback = defaultCompositionTarget();
      target = fallback && !isRootCompositionTarget(fallback) ? fallback : null;
    }
    if (!target || isRootCompositionTarget(target) || !snapshot?.projectRoot) {
      setActionError("Choose a component insertion target before asking the agent to build one.");
      return;
    }
    const session = await ensureCurrentDashboardEdit();
    if (!session) return;
    const parent = nodeAtPath(session.draft.root, target.parentPath);
    const insertionPath = dashboardInsertionPath(
      target,
      target.placement.type === "tiled" && !parent.children ? "empty" : "split",
    );
    const prompt = buildComponentCreationAgentPrompt({
      projectRoot: session.projectRoot,
      configPath: session.configPath,
      insertionPath,
    }, description);
    const dirty = JSON.stringify(session.original) !== JSON.stringify(session.draft);
    if (dirty) {
      setDiscardConfirmation({
        message: "Discard the dashboard draft and ask the configured agent to build this component?",
        continueAction: () => void runComponentCreationAgent(session.configPath, target!, prompt),
      });
      return;
    }
    void runComponentCreationAgent(session.configPath, target, prompt);
  }

  async function removeCompositionNode(path: NodePath): Promise<void> {
    const session = await ensureCurrentDashboardEdit();
    if (!session || path.length === 0) return;
    try {
      nodeAtPath(session.draft.root, path);
    } catch {
      setActionError("The component moved before removal could be confirmed.");
      return;
    }
    compositionInteraction.requestRemoval(path);
  }

  function handleCompositionDrop(target: CompositionTarget, payload: CompositionDragPayload): void {
    if (!compositionSourceIsReady()) return;
    if (!compositionTargetIsValid(target, payload)) return;
    if (payload.type === "component") {
      void openCompositionDialog(target, payload.reference);
      return;
    }
    void ensureCurrentDashboardEdit().then((session) => {
      if (!session || isRootCompositionTarget(target)) return;
      const planned = planCompositionOperation({
        config: session.draft,
        catalog: session.componentCatalog,
        payload,
        target,
      });
      if (planned.status !== "planned") {
        setActionError(planned.message);
        return;
      }
      try {
        const next = planned.nextConfig;
        setEditSession((current) => current && current.configPath === session.configPath
          ? { ...current, draft: next }
          : current);
        compositionInteraction.endDrag();
        compositionInteraction.clearTarget();
      } catch (error) {
        setActionError(errorMessage(error));
      }
    });
  }

  function handleCompositionSplitRatio(
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
    node: ResolvedComponentNode,
    splitPath: readonly LayoutBranch[],
  ): void {
    if (editingComposition && editSession) {
      const path = nodePathById(editSession.draft.root, node.id);
      if (!path) {
        setActionError("The tiled component moved before its split could be updated.");
        return;
      }
      try {
        const next = ratio === null
          ? editSession.draft
          : updateTiledSplitRatio(editSession.draft, path, splitPath, ratio);
        setEditSession({ ...editSession, draft: next });
      } catch (error) {
        setActionError(errorMessage(error));
      }
      return;
    }
    if (componentLibraryOpen) {
      void ensureCurrentDashboardEdit().then((session) => {
        if (!session) return;
        const path = nodePathById(session.draft.root, node.id);
        if (!path) {
          setActionError("The tiled component moved before its split could be updated.");
          return;
        }
        try {
          const next = updateTiledSplitRatio(session.draft, path, splitPath, ratio ?? defaultRatio);
          setEditSession((current) => current && current.configPath === session.configPath
            ? { ...current, draft: next }
            : current);
        } catch (error) {
          setActionError(errorMessage(error));
        }
      });
      return;
    }
    updateSplitRatio(branchKey, defaultRatio, ratio);
  }

  function applyCompositionDraft(next: DashboardConfig): void {
    setEditSession((current) => current ? { ...current, draft: next } : current);
    compositionInteraction.dismissDialog();
    compositionInteraction.clearTarget();
  }

  // Composition is always ready for direct header drags. A drag itself opens
  // the flyout and begins a draft only after a valid move or removal.
  const compositionContextValue = compositionConfig && compositionPreviewTree
    ? {
        active: true,
        dragging: compositionDrag,
        pointer: compositionPointer,
        config: compositionConfig,
        catalog: compositionCatalog,
        pathForNode: compositionPathForNode,
        dropZonesForNode: compositionDropZonesForNode,
        pointerDropZoneForNode: compositionPointerDropZone,
        canDrop: compositionTargetIsValid,
        onNodeDragStart: compositionInteraction.beginNodeDrag,
        onNodeDragEnd: () => {
          clearPendingCompositionPointer();
          compositionInteraction.endDrag();
        },
        onNodePointerDragMove: (path: NodePath, point: ComponentPointerDragPoint) => {
          scheduleCompositionPointerDrag({ type: "node", path }, point);
        },
        onNodePointerDrop: (path: NodePath, point: ComponentPointerDragPoint) => {
          dropCompositionPointer({ type: "node", path }, point);
        },
        onLibraryDragStart: compositionInteraction.beginLibraryDrag,
        onLibraryDragEnd: () => {
          clearPendingCompositionPointer();
          compositionInteraction.endDrag();
        },
        onDragTarget: (nodeId: string | null, zone: CompositionDropZone | null) => {
          compositionInteraction.updatePointer(zone && nodeId ? {
            nodeId,
            zoneId: zone.id,
            clientX: 0,
            clientY: 0,
          } : null);
        },
        onDrop: handleCompositionDrop,
      }
    : null;

  useEffect(() => {
    if (!componentLibraryOpen || editSession || !snapshot?.projectRoot || !snapshot.configPath) return;
    const focusedSource = virtualRoot?.node.sourceConfigPath;
    if (!focusedSource || focusedSource === snapshot.configPath) {
      if (compositionSource !== null) setCompositionSource(null);
      return;
    }
    if (
      compositionSource?.projectRoot === snapshot.projectRoot
      && compositionSource.activeDashboardPath === snapshot.configPath
      && compositionSource.focusedSourcePath === focusedSource
      && compositionSource.snapshotRevision === snapshot.revision
      && compositionSource.configPath === focusedSource
    ) return;
    void loadCompositionSource();
  }, [
    componentLibraryOpen,
    compositionSource,
    editSession,
    snapshot?.configPath,
    snapshot?.projectRoot,
    snapshot?.revision,
    virtualRoot?.node.sourceConfigPath,
  ]);

  const compositionUiActive = componentLibraryOpen
    || compositionDialog !== null
    || compositionRemovePath !== null
    || discardConfirmation !== null
    || deletionDialog !== null
    || agentDialog !== null
    || paletteOpen
    || (editingComposition && (draftDirty || compositionDrag !== null));

  function focusComponent(nodeId: string): void {
    if (!dashboardPath) return;
    expandComponent(dashboardPath, nodeId);
    storeVirtualRoot(dashboardPath, nodeId);
  }

  async function editCompositionNode(node: ResolvedComponentNode): Promise<void> {
    if (!compositionSourceIsReady()) return;
    const sourcePath = compositionPathForNode(node);
    if (!sourcePath) {
      setActionError("The component could not be located in its dashboard configuration.");
      return;
    }
    const session = await ensureCurrentDashboardEdit();
    if (!session) return;
    const path = nodePathById(session.draft.root, node.id) ?? sourcePath;
    try {
      nodeAtPath(session.draft.root, path);
    } catch {
      setActionError("The component moved before editing could be opened.");
      return;
    }
    compositionInteraction.showDialog({ mode: "configure", path });
  }

  async function focusProjectNode(targetProject: ProjectTarget, nodeId: string): Promise<void> {
    if (snapshot?.configPath === targetProject.configPath) {
      setActiveView("dashboard");
      expandComponent(targetProject.configPath, nodeId);
      storeVirtualRoot(targetProject.configPath, nodeId);
      return;
    }
    if (editSession && editSession.configPath !== targetProject.configPath && !requireDiscard(
      "Discard the unsaved dashboard changes and navigate to another dashboard node?",
      () => void focusProjectNode(targetProject, nodeId),
    )) return;

    let opened = false;
    await perform(`open:${targetProject.configPath}`, async () => {
      await host.openProject(targetProject);
      setActiveView("dashboard");
      opened = true;
    });
    if (opened) {
      expandComponent(targetProject.configPath, nodeId);
      storeVirtualRoot(targetProject.configPath, nodeId);
    }
  }

  const nodeFocusActions = buildNodeFocusActions(
    snapshot,
    virtualRoot?.node.id ?? null,
    editingActiveProject,
    (nodeId) => {
      setActiveView("dashboard");
      focusComponent(nodeId);
    },
  );
  const allActions = [...applicationActions, ...nodeFocusActions, ...componentActions];
  actionsByIdRef.current = new Map(allActions.map((action) => [action.id, action]));

  async function executePaletteAction(id: string): Promise<void> {
    setActionError(null);
    const result = await actionExecutor.run(id);
    if (result.status === "failed") setActionError(errorMessage(result.error));
    else if (result.status === "unavailable") setActionError(result.reason);
    else if (result.status === "running") {
      setActionError("That action is already running.");
    }
  }

  if (loading) {
    return (
      <main className="boot" aria-live="polite">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <span className="spinner" aria-hidden="true" />
        Loading dash-bored…
      </main>
    );
  }

  if (!snapshot && actionError) {
    return (
      <main className="boot boot--error">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1>dash-bored could not reach its desktop host</h1>
        <p>{actionError}</p>
      </main>
    );
  }

  const title = snapshot?.dashboardName?.trim() || (snapshot?.projectRoot ? basename(snapshot.projectRoot) : "dash-bored");
  const headerDashboardPath = snapshot?.configPath ?? snapshot?.projectRoot ?? null;
  const actionScope = `${snapshot?.projectRoot ?? "no-project"}\u0000${
    snapshot?.revision ?? 0
  }\u0000${snapshot?.trusted ? "trusted" : "restricted"}`;
  const shortcutLabel =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";
  const visibleVirtualRoot = editingComposition ? compositionVirtualRoot : virtualRoot;
  const compositionExisting = compositionDialog?.mode === "configure"
    && editSession
    && compositionDialog.path
    ? (() => {
        try {
          return { path: compositionDialog.path, node: nodeAtPath(editSession.draft.root, compositionDialog.path) };
        } catch {
          return null;
        }
      })()
    : null;
  const compositionRemoving = compositionRemovePath && editSession
    ? (() => {
        try {
          return nodeAtPath(editSession.draft.root, compositionRemovePath);
        } catch {
          return null;
        }
      })()
    : null;
  const workspace = (
    <>
      {activeView === "settings" ? (
        <SettingsPanel
            snapshot={snapshot}
            appSettings={appSettings}
            pendingAction={pendingAction}
            onSaveAgent={saveAgentSetting}
            onReload={() => void perform("reload", host.reloadProject)}
            onTrust={() => void perform("trust", host.trustProject)}
            onRevoke={() => void perform("revoke", host.revokeTrust)}
          />
      ) : !snapshot?.projectRoot ? (
        <EmptyProject
          pending={pendingAction === "choose"}
          onChoose={() => void addDashboard()}
        />
      ) : (
        <main className="workspace">
            {editSession && editSession.projectRoot === snapshot.projectRoot && !compositionPreviewTree ? (
              <DashboardEditor
                config={editSession.draft}
                catalog={editSession.componentCatalog}
                diagnostics={editSession.validation.diagnostics}
                projectRoot={editSession.projectRoot}
                configPath={editSession.configPath}
                agentCommand={appSettings.dashBoredAgent}
                agentPending={pendingAction === "component-agent:create"}
                onBuildWithAgent={requestComponentCreationAgent}
                onChange={(draft) => setEditSession((current) => current ? { ...current, draft } : current)}
              />
            ) : (
              <>
            {!snapshot.trusted ? (
              <TrustPanel snapshot={snapshot} pending={pendingAction === "trust"} onTrust={() => void perform("trust", host.trustProject)} />
            ) : null}

            <Diagnostics diagnostics={snapshot.diagnostics} />

            {snapshot.tree ? (
              <section className="dashboard" aria-label={`${title} dashboard`}>
                {visibleVirtualRoot && visibleVirtualRoot.crumbs.length > 1 ? (
                  <nav className="dashboard-breadcrumbs" aria-label="Focused component path">
                    {visibleVirtualRoot.crumbs.map((crumb, index) => (
                      <span className="dashboard-breadcrumbs__item" key={crumb.id}>
                        {index < visibleVirtualRoot.crumbs.length - 1 ? (
                          <button type="button" onClick={() => focusComponent(crumb.id)}>{crumb.label}</button>
                        ) : <span aria-current="page">{crumb.label}</span>}
                        {index < visibleVirtualRoot.crumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
                      </span>
                    ))}
                  </nav>
                ) : null}
                <ComponentVisibilityContext.Provider value={!compositionUiActive}>
                  <CompositionContext.Provider value={compositionContextValue}>
                    <NodeRenderer
                      node={visibleVirtualRoot?.node ?? snapshot.tree}
                      trusted={snapshot.trusted}
                      processes={processes}
                      localComponents={localComponents}
                      actionRegistry={actionRegistry}
                      actionScope={actionScope}
                      updateBatch={componentUpdateBatch}
                      collapsedNodeIds={activeCollapsedComponentIds}
                      splitRatioOverrides={editingComposition ? EMPTY_SPLIT_RATIO_OVERRIDES : activeSplitRatioOverrides}
                      componentHeightOverrides={activeComponentHeightOverrides}
                      onFocus={focusComponent}
                      onToggleCollapse={toggleComponentCollapse}
                      onSplitRatioChange={handleCompositionSplitRatio}
                      onComponentHeightChange={updateComponentHeight}
                      onCopyPath={(node) => void copyComponentPath(node)}
                      onEditComponent={(node) => void editCompositionNode(node)}
                      onOpenAgent={setAgentDialog}
                      isVirtualRoot
                    />
                  </CompositionContext.Provider>
                </ComponentVisibilityContext.Provider>
              </section>
            ) : (
              <section className="empty-dashboard">
                <span className="eyebrow">Configuration unavailable</span>
                <h1>The dashboard could not be rendered.</h1>
                <p>Fix the diagnostics above, then reload the project.</p>
                <button className="button button--secondary" type="button" disabled={pendingAction !== null} onClick={() => void perform("reload", host.reloadProject)}>Try again</button>
              </section>
            )}

              </>
            )}

            <footer className="workspace__footer">
              <span>Revision {snapshot.revision}</span>
              <span>{snapshot.trusted ? "Capabilities enabled" : "Restricted mode"}</span>
            </footer>
        </main>
      )}
    </>
  );
  return (
    <>
      <AppShell
        snapshot={snapshot}
        projects={projects}
        activeView={activeView}
        sidebarExpanded={sidebarExpanded}
        expandedProjectOutlines={expandedProjectOutlines}
        pendingAction={pendingAction}
        projectOutlines={projectOutlines}
        title={title}
        dashboardPath={headerDashboardPath}
        shortcutLabel={shortcutLabel}
        editing={editingActiveProject}
        componentLibraryOpen={componentLibraryOpen}
        editorToolbar={
          editSession && editingActiveProject ? (
            <div className="app-header__editor-toolbar">
              <DashboardEditorToolbar
                diagnostics={editSession.validation.diagnostics}
                saving={savingDraft}
                dirty={editSessionDirty()}
                onSave={() => void saveDashboardDraft()}
                onCancel={cancelDashboardEdit}
              />
            </div>
          ) : null
        }
        actionError={actionError}
        actionNotice={
          actionNotice ? (
            <div className="global-notice" role="status">
              <span>{actionNotice.message}</span>
              <button
                className="global-notice__close"
                type="button"
                aria-label="Dismiss message"
                onClick={() => setActionNotice(null)}
              >
                <svg
                  className="global-notice__countdown"
                  viewBox="0 0 28 28"
                  aria-hidden="true"
                >
                  <circle
                    className="global-notice__countdown-track"
                    cx="14"
                    cy="14"
                    r="11"
                  />
                  <circle
                    className="global-notice__countdown-progress"
                    cx="14"
                    cy="14"
                    r="11"
                    pathLength="1"
                  />
                </svg>
                <span aria-hidden="true">×</span>
              </button>
            </div>
          ) : null
        }
        onToggleSidebar={() => setSidebarExpanded((expanded) => !expanded)}
        onSelectProject={(project) => void selectProject(project)}
        onToggleProjectOutline={toggleProjectOutline}
        onFocusProjectNode={(project, nodeId) => void focusProjectNode(project, nodeId)}
        onOpenDeletion={(project) => void openDeletionDialog(project)}
        onAddDashboard={() => void addDashboard()}
        onShowSettings={showSettings}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleLibrary={toggleCompositionLibrary}
        onDismissError={() => setActionError(null)}
      >
        {workspace}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        actions={allActions}
        runningActionIds={runningActionIds}
        onDismiss={() => setPaletteOpen(false)}
        onExecute={(id) => void executePaletteAction(id)}
      />
      <CompositionFlyout
        open={componentLibraryOpen}
        dragging={compositionDrag}
        catalog={compositionCatalog}
        onClose={compositionInteraction.closeLibrary}
        onInsert={handleCompositionInsert}
        onRemoveDrop={(path) => void removeCompositionNode(path)}
        onBuildWithAgent={(description) => void handleCompositionAgent(description)}
        onPointerDragMove={handleCompositionPointerDragMove}
        onPointerDrop={handleCompositionPointerDrop}
        onDragStateChange={(entry) => {
          if (entry) {
            compositionInteraction.beginLibraryDrag(entry.reference);
          } else {
            clearPendingCompositionPointer();
            compositionInteraction.endDrag();
          }
        }}
        agentPending={pendingAction === "component-agent:create"}
        loading={compositionSourcePending}
      />
      {compositionDialog && editSession && editingActiveProject && compositionDialog.mode === "configure" && compositionExisting ? (
        <ComponentDialog
          catalog={editSession.componentCatalog}
          config={editSession.draft}
          existing={compositionExisting}
          onApply={applyCompositionDraft}
          onDismiss={compositionInteraction.dismissDialog}
        />
      ) : null}
      {compositionDialog && editSession && editingActiveProject && compositionDialog.mode === "replace" ? (
        <ComponentDialog
          catalog={editSession.componentCatalog}
          config={editSession.draft}
          replace={editSession.draft.root}
          initialReference={compositionDialog.reference}
          onApply={applyCompositionDraft}
          onDismiss={compositionInteraction.dismissDialog}
        />
      ) : null}
      {compositionDialog && editSession && editingActiveProject && compositionDialog.mode === "add" && compositionDialog.target ? (
        <ComponentDialog
          catalog={editSession.componentCatalog}
          config={editSession.draft}
          target={compositionDialog.target}
          initialReference={compositionDialog.reference}
          projectRoot={editSession.projectRoot}
          configPath={editSession.configPath}
          agentCommand={appSettings.dashBoredAgent}
          agentPending={pendingAction === "component-agent:create"}
          onBuildWithAgent={requestComponentCreationAgent}
          onApply={applyCompositionDraft}
          onDismiss={compositionInteraction.dismissDialog}
        />
      ) : null}
      {compositionRemovePath && compositionRemoving && editSession && editingActiveProject ? (
        <EditorModal title="Remove component?" onDismiss={compositionInteraction.dismissRemoval}>
          <div className="remove-confirmation">
            <p>Remove <strong>{catalogManifest(editSession.componentCatalog, compositionRemoving.component)?.name ?? compositionRemoving.component}</strong>?</p>
            {countNodes(compositionRemoving) > 1 ? <p>This also removes {countNodes(compositionRemoving) - 1} nested components.</p> : null}
            <p>The change remains recoverable until you save the dashboard.</p>
            <footer className="editor-modal__actions">
              <button className="button button--quiet" type="button" onClick={compositionInteraction.dismissRemoval}>Cancel</button>
              <button className="button button--danger" type="button" onClick={() => {
                try {
                  const next = removeNode(editSession.draft, compositionRemovePath, editSession.componentCatalog);
                  setEditSession({ ...editSession, draft: next });
                  compositionInteraction.dismissRemoval();
                  compositionInteraction.clearTarget();
                } catch (error) {
                  setActionError(errorMessage(error));
                }
              }}>Remove</button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
      {agentDialog ? (
        <EditorModal
          title={`Change ${agentDialog.configName?.trim() || agentDialog.manifest?.name || agentDialog.component}`}
          onDismiss={() => {
            if (pendingAction !== `component-agent:${agentDialog.id}`) setAgentDialog(null);
          }}
        >
          <AgentPromptPanel
            key={agentDialog.id}
            node={agentDialog}
            agentCommand={appSettings.dashBoredAgent}
            pending={pendingAction === `component-agent:${agentDialog.id}`}
            onDismiss={() => setAgentDialog(null)}
            onSend={(prompt) => runComponentAgent(agentDialog, prompt)}
          />
        </EditorModal>
      ) : null}
      {discardConfirmation ? (
        <EditorModal title="Discard dashboard changes?" onDismiss={() => setDiscardConfirmation(null)}>
          <div className="remove-confirmation">
            <p>{discardConfirmation.message}</p>
            <p>This draft has not been written to dash-bored.yaml.</p>
            <footer className="editor-modal__actions">
              <button className="button button--quiet" type="button" onClick={() => setDiscardConfirmation(null)}>Keep editing</button>
              <button className="button button--danger" type="button" onClick={() => {
                const continueAction = discardConfirmation.continueAction;
                setDiscardConfirmation(null);
                setEditSession(null);
                resetCompositionUi();
                queueMicrotask(continueAction);
              }}>Discard changes</button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
      {deletionDialog ? (
        <EditorModal title="Remove dashboard?" onDismiss={() => setDeletionDialog(null)}>
          <div className="remove-confirmation dashboard-delete-confirmation">
            <p>
              Remove <strong>{projectLabel(deletionDialog.project)}</strong> from the dash-bored sidebar?
              The dashboard entry is removed by default; its project files stay on disk.
            </p>

            {deletionDialog.preview.dependencies.length > 0 ? (
              <section className="dashboard-delete-dependencies" aria-labelledby="dashboard-delete-dependencies-title">
                <h3 id="dashboard-delete-dependencies-title">Dashboards that use these files</h3>
                <p>
                  These links may stop working if the app-owned project files are moved to Trash.
                </p>
                <ul>
                  {deletionDialog.preview.dependencies.map((dependency) => (
                    <li key={dependency.projectRoot}>
                      <strong>{dependency.dashboardName?.trim() || basename(dependency.projectRoot)}</strong>
                      <ul>
                        {dependency.configPaths.map((configPath) => <li key={configPath}><code>{configPath}</code></li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {!deletionDialog.preview.analysisComplete ? (
              <section className="dashboard-delete-issues" role="alert">
                <strong>File removal is unavailable</strong>
                <p>
                  dash-bored could not safely complete dependency analysis, so the project files cannot be moved to Trash from this dialog.
                </p>
                <ul>
                  {deletionDialog.preview.analysisIssues.map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              </section>
            ) : null}

            {deletionDialog.preview.filesExist ? (
              <label className={`dashboard-delete-files-option${deletionDialog.removeFiles ? " dashboard-delete-files-option--selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={deletionDialog.removeFiles}
                  disabled={!deletionDialog.preview.analysisComplete}
                  onChange={(event) => setDeletionDialog((current) => current ? { ...current, removeFiles: event.target.checked } : current)}
                />
                <span>
                  <strong>Also move project files to Trash</strong>
                  <small>Moves only {deletionDialog.preview.filesDirectory} and its nested dash-bored bundles, components, locks, and environment files.</small>
                </span>
              </label>
            ) : (
              <p className="dashboard-delete-no-files">No app-owned dash-bored/ directory was found, so only the sidebar entry will be removed.</p>
            )}

            {deletionDialog.removeFiles ? (
              <section className="dashboard-delete-warning" role="alert">
                <strong>Project files will be moved to the OS Trash.</strong>
                <p>This removes the dashboard’s app-owned files and can break the links listed above. Source project files outside dash-bored/ are never touched.</p>
              </section>
            ) : null}

            <footer className="editor-modal__actions">
              <button className="button button--quiet" data-modal-close type="button" onClick={() => setDeletionDialog(null)}>Cancel</button>
              <button
                className="button button--danger"
                type="button"
                disabled={deletionDialog.removeFiles && !deletionDialog.preview.analysisComplete}
                onClick={() => void confirmDeletion()}
              >
                {deletionDialog.removeFiles ? "Move files to Trash & remove" : "Remove dashboard"}
              </button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
    </>
  );
}
