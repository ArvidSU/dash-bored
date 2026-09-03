import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ProcessSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { ComponentHeightOverrides } from "../lib/component-height";
import { componentRendersSurface } from "../lib/component-height";
import type { SplitRatioOverrides } from "./split-layout";
import type { LayoutBranch } from "../lib/component-children";
import { changedComponentIds, updateStaggerMs } from "../lib/component-updates";
import { composeComponentChildren } from "../composition/ComponentCompositor";
import { packagedComponent } from "../builtins";
import { LocalComponentErrorBoundary } from "./local-components";
import type { LoadedLocalComponent } from "./local-components";
import type { ActionRegistry } from "../lib/actions";
import { ComponentFrame } from "./ComponentFrame";
import { createLocalHost } from "./local-host";

export interface NodeRendererProps {
  node: ResolvedComponentNode;
  trusted: boolean;
  /**
   * Stays stable while process output arrives, so unrelated local-component
   * effects do not restart for every terminal log update. `get()` still reads
   * the current process snapshot through this ref.
   */
  processesRef: Readonly<{ current: ReadonlyMap<string, ProcessSnapshot> }>;
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
  onUpdateProps: (node: ResolvedComponentNode, props: Record<string, unknown>) => Promise<void>;
  isVirtualRoot?: boolean;
}

export interface ComponentUpdateBatch {
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

export function NodeRenderer({
  node,
  trusted,
  processesRef,
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
  onUpdateProps,
  isVirtualRoot = false,
}: NodeRendererProps): ReactNode {
  const permissionsKey = (node.manifest?.permissions ?? []).join("\u0000");
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const updateProps = useCallback(
    (props: Record<string, unknown>): Promise<void> => onUpdateProps(nodeRef.current, props),
    [onUpdateProps],
  );
  const localHost = useMemo(
    () => createLocalHost(node, actionRegistry, actionScope, trusted, processesRef, updateProps),
    [actionRegistry, actionScope, node.id, node.manifest?.name, permissionsKey, processesRef, trusted, updateProps],
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
            processesRef={processesRef}
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
            onUpdateProps={onUpdateProps}
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

export function useComponentUpdateBatch(
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
