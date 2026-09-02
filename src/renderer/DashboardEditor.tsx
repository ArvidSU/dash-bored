import { useEffect, useId, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import type {
  ComponentCatalogItem,
  ComponentChildLayout,
  ComponentChildPlacement,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  Diagnostic,
} from "../shared/contracts";
import { childEdges, edgeAtLocator, type LayoutBranch } from "./component-children";
import { PERMISSION_LABELS } from "./action-providers";
import { SplitLayout } from "./SplitLayout";
import {
  DEFAULT_SPLIT_MIN_PX,
  normalizeSplitRatio,
} from "./split-layout";
import {
  catalogManifest,
  collapsibleNodePaths,
  countDiscardedRootNodes,
  countNodes,
  defaultChildMetadata,
  managedChildEdges,
  nodeAtPath,
  nodePathById,
  pathEquals,
  pathKey,
  removeNode,
  updateChildMetadata,
  updateDashboardMetadata,
  updateNodeProps,
  updateTiledSplitRatio,
  type InsertionTarget,
  type NodePath,
} from "./dashboard-editor";
import { planCompositionOperation } from "./composition-operation";

const DRAG_TYPE = "application/x-dash-bored-node";

interface ModalProps {
  title: string;
  children: ReactNode;
  className?: string;
  onDismiss: () => void;
}

export function EditorModal({ title, children, className, onDismiss }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", close);
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(
      "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)",
    )?.focus());
    return () => {
      window.removeEventListener("keydown", close);
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(".composition-library-trigger")?.focus();
    };
  }, [onDismiss]);
  return (
    <div className="editor-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onDismiss();
    }}>
      <div className={className ? `editor-modal__panel ${className}` : "editor-modal__panel"} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <header className="editor-modal__header">
          <h2 id={titleId}>{title}</h2>
          <button className="editor-icon-button" type="button" aria-label="Close" onClick={onDismiss}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const value = schema.properties;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Record<string, unknown>>
    : {};
}

function requiredProperties(schema: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : []);
}

function initialValues(schema: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(current);
  for (const [name, property] of Object.entries(schemaProperties(schema))) {
    if (!(name in next) && "default" in property) next[name] = structuredClone(property.default);
  }
  return next;
}

function SchemaEditor({
  schema,
  value,
  onChange,
  label,
}: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  label: string;
}): ReactNode {
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const required = requiredProperties(schema);
  const properties = schemaProperties(schema);
  if (advanced) {
    return (
      <div className="props-editor">
        <textarea
          className="props-editor__json"
          aria-label={`${label} JSON`}
          value={json}
          spellCheck={false}
          onChange={(event) => {
            setJson(event.target.value);
            try {
              const parsed: unknown = JSON.parse(event.target.value);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter a JSON object.");
              setError(null);
              onChange(parsed as Record<string, unknown>);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        />
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <button className="button button--quiet" type="button" onClick={() => setAdvanced(false)}>Use fields</button>
      </div>
    );
  }
  return (
    <div className="props-editor">
      {Object.entries(properties).map(([name, property]) => {
        const title = typeof property.title === "string" ? property.title : name;
        const current = value[name];
        const enumValues = Array.isArray(property.enum) ? property.enum : null;
        const change = (nextValue: unknown): void => {
          const next = { ...value };
          if (nextValue === "" && !required.has(name)) delete next[name];
          else next[name] = nextValue;
          onChange(next);
        };
        return (
          <label className="props-field" key={name}>
            <span>{title}{required.has(name) ? <em>Required</em> : null}</span>
            {enumValues ? (
              <select value={current === undefined ? "" : String(current)} onChange={(event) => {
                change(enumValues.find((item) => String(item) === event.target.value));
              }}>
                {!required.has(name) ? <option value="">Not set</option> : null}
                {enumValues.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}
              </select>
            ) : property.type === "boolean" ? (
              <input type="checkbox" checked={current === true} onChange={(event) => change(event.target.checked)} />
            ) : (
              <input
                type={property.type === "number" || property.type === "integer" ? "number" : "text"}
                step={property.type === "integer" ? 1 : "any"}
                value={current === undefined ? "" : String(current)}
                onChange={(event) => change(
                  property.type === "number" || property.type === "integer"
                    ? event.target.value === "" ? "" : Number(event.target.value)
                    : event.target.value,
                )}
              />
            )}
            {typeof property.description === "string" ? <small>{property.description}</small> : null}
          </label>
        );
      })}
      {Object.keys(properties).length === 0 ? <p className="editor-muted">No fields are declared.</p> : null}
      <button className="button button--quiet" type="button" onClick={() => {
        setJson(JSON.stringify(value, null, 2));
        setAdvanced(true);
      }}>Advanced JSON</button>
    </div>
  );
}

export function ComponentDialog({
  catalog,
  config,
  target,
  existing,
  replace,
  projectRoot,
  configPath,
  initialReference,
  agentCommand,
  agentPending,
  onBuildWithAgent,
  onApply,
  onDismiss,
}: {
  catalog: readonly ComponentCatalogItem[];
  config: DashboardConfig;
  target?: InsertionTarget;
  existing?: { path: NodePath; node: ComponentNode };
  replace?: ComponentNode;
  projectRoot?: string;
  configPath?: string;
  initialReference?: string;
  agentCommand?: string;
  agentPending?: boolean;
  onBuildWithAgent?: (target: InsertionTarget, prompt: string) => void;
  onApply: (config: DashboardConfig) => void;
  onDismiss: () => void;
}): ReactNode {
  const current = existing?.node ?? replace;
  const [query, setQuery] = useState("");
  const [reference, setReference] = useState(current?.component ?? initialReference ?? "");
  const item = catalog.find((entry) => entry.reference === reference);
  const [props, setProps] = useState<Record<string, unknown>>(() =>
    item?.manifest ? initialValues(item.manifest.propsSchema, current?.props ?? {}) : {});
  const [metadata, setMetadata] = useState<Record<string, unknown>>(() => {
    if (!existing || existing.path.length === 0) return target?.placement.metadata ?? {};
    const parent = nodeAtPath(config.root, existing.path.slice(0, -1));
    return edgeAtLocator(parent.children, existing.path.at(-1)!).metadata ?? {};
  });
  const [applyError, setApplyError] = useState<string | null>(null);
  const available = catalog.filter((entry) => {
    const text = `${entry.manifest?.name ?? ""} ${entry.reference} ${entry.manifest?.description ?? ""}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  });
  const parent = existing && existing.path.length > 0
    ? nodeAtPath(config.root, existing.path.slice(0, -1))
    : target ? nodeAtPath(config.root, target.parentPath) : null;
  const metadataSchema = parent ? catalogManifest(catalog, parent.component)?.children?.metadataSchema : undefined;
  const canBuild = Boolean(target && onBuildWithAgent && projectRoot && configPath && agentCommand?.trim() && query.trim() && available.length === 0);
  const discardedRootNodes = replace && item ? countDiscardedRootNodes(config, item) : 0;

  const choose = (entry: ComponentCatalogItem): void => {
    if (!entry.manifest || !entry.available) return;
    setReference(entry.reference);
    setProps(initialValues(
      entry.manifest.propsSchema,
      current?.component === entry.reference ? current.props ?? {} : {},
    ));
  };

  return (
    <EditorModal title={replace ? "Replace dashboard root" : existing ? "Configure component" : "Add component"} onDismiss={onDismiss}>
      {!item?.manifest ? (
        <div className="component-picker">
          <input className="component-picker__search" type="search" placeholder="Search or describe a component…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="component-picker__list">
            {available.map((entry) => (
              <button type="button" key={entry.reference} disabled={!entry.available || !entry.manifest} onClick={() => choose(entry)}>
                <strong>{entry.manifest?.name ?? entry.reference}</strong>
                <span>{entry.manifest?.description ?? entry.diagnostics[0]?.message}</span>
              </button>
            ))}
          </div>
          {canBuild && target && onBuildWithAgent && projectRoot && configPath ? (
            <button className="button button--secondary" type="button" disabled={agentPending} onClick={() => {
              onBuildWithAgent(target, query.trim());
            }}>{agentPending ? "Starting agent…" : "Build with agent"}</button>
          ) : null}
        </div>
      ) : (
        <form className="component-config" onSubmit={(event) => {
          event.preventDefault();
          if (replace) {
            const planned = planCompositionOperation({
              config,
              catalog,
              payload: { type: "component", reference: item.reference, props },
              target: { type: "root-replacement", path: [] },
            });
            if (planned.status !== "planned") {
              setApplyError(planned.message);
              return;
            }
            onApply(planned.nextConfig);
          } else if (existing) {
            let next = updateNodeProps(config, existing.path, props);
            if (existing.path.length > 0 && metadataSchema) next = updateChildMetadata(next, existing.path, metadata);
            onApply(next);
          } else if (target) {
            const planned = planCompositionOperation({
              config,
              catalog,
              payload: { type: "component", reference: item.reference, props },
              target: {
              ...target,
              placement: { ...target.placement, ...(Object.keys(metadata).length ? { metadata } : {}) },
              },
            });
            if (planned.status !== "planned") {
              setApplyError(planned.message);
              return;
            }
            onApply(planned.nextConfig);
          }
          onDismiss();
        }}>
          <div className="component-config__identity">
            <strong>{item.manifest.name}</strong><code>{item.reference}</code>
            {item.manifest.permissions?.length ? (
              <span>{item.manifest.permissions.map((permission) => PERMISSION_LABELS[permission]).join(", ")}</span>
            ) : null}
          </div>
          {replace && discardedRootNodes > 0 ? (
            <p className="inline-warning" role="alert">
              This replacement will discard {discardedRootNodes} nested component{discardedRootNodes === 1 ? "" : "s"}; the change remains recoverable until you save.
            </p>
          ) : null}
          {applyError ? <p className="inline-error" role="alert">{applyError}</p> : null}
          <SchemaEditor schema={item.manifest.propsSchema} value={props} onChange={setProps} label="Component props" />
          {metadataSchema ? (
            <fieldset>
              <legend>Child presentation metadata</legend>
              <SchemaEditor schema={metadataSchema} value={metadata} onChange={setMetadata} label="Child metadata" />
            </fieldset>
          ) : null}
          <footer className="editor-modal__actions">
            <button className="button button--quiet" type="button" onClick={onDismiss}>Cancel</button>
            <button className="button button--primary" type="submit">{replace ? "Replace root" : existing ? "Apply" : "Add component"}</button>
          </footer>
        </form>
      )}
    </EditorModal>
  );
}

export interface DashboardEditorToolbarProps {
  diagnostics: readonly Diagnostic[];
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export function DashboardEditorToolbar({ diagnostics, saving, dirty, onSave, onCancel }: DashboardEditorToolbarProps): ReactNode {
  const valid = diagnostics.every((item) => item.severity !== "error");
  return (
    <div className="editor-toolbar" role="region" aria-label="Dashboard editor">
      <div className="editor-toolbar__actions">
        <button className="button button--quiet" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
        <button className="button button--primary" type="button" disabled={saving || !dirty || !valid} onClick={onSave}>{saving ? "Saving…" : "Save dashboard"}</button>
      </div>
    </div>
  );
}

interface DashboardEditorProps {
  config: DashboardConfig;
  catalog: readonly ComponentCatalogItem[];
  diagnostics: readonly Diagnostic[];
  projectRoot: string;
  configPath: string;
  agentCommand?: string;
  agentPending?: boolean;
  onBuildWithAgent?: (target: InsertionTarget, prompt: string) => void;
  onChange: (config: DashboardConfig) => void;
}

function tiledPlacements(
  manifest: ComponentManifest,
  path: LayoutBranch[],
): Array<{ label: string; placement: ComponentChildPlacement }> {
  if (manifest.children?.presentation.type !== "tiled") return [];
  const axes = manifest.children.presentation.axes;
  return [
    ...(axes !== "vertical" ? [
      { label: "Tile left", placement: { type: "tiled", path, axis: "horizontal", position: "first" } as const },
      { label: "Tile right", placement: { type: "tiled", path, axis: "horizontal", position: "second" } as const },
    ] : []),
    ...(axes !== "horizontal" ? [
      { label: "Tile above", placement: { type: "tiled", path, axis: "vertical", position: "first" } as const },
      { label: "Tile below", placement: { type: "tiled", path, axis: "vertical", position: "second" } as const },
    ] : []),
  ];
}

export function DashboardEditor({
  config,
  catalog,
  diagnostics,
  projectRoot,
  configPath,
  agentCommand,
  agentPending,
  onBuildWithAgent,
  onChange,
}: DashboardEditorProps): ReactNode {
  const [selectedPath, setSelectedPath] = useState<NodePath>([]);
  const [configurePath, setConfigurePath] = useState<NodePath | null>(null);
  const [removePath, setRemovePath] = useState<NodePath | null>(null);
  const [addTarget, setAddTarget] = useState<InsertionTarget | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [dragging, setDragging] = useState<NodePath | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(
    collapsibleNodePaths(config.root).filter((path) => path.length > 0).map(pathKey),
  ));
  const [error, setError] = useState<string | null>(null);
  const valid = diagnostics.every((item) => item.severity !== "error");

  let selected = config.root;
  let effectiveSelectedPath = selectedPath;
  try { selected = nodeAtPath(config.root, selectedPath); } catch { effectiveSelectedPath = []; }
  const selectedManifest = catalogManifest(catalog, selected.component);

  const apply = (operation: () => DashboardConfig, fallback = effectiveSelectedPath): void => {
    try {
      const next = operation();
      const nextPath = selected.id ? nodePathById(next.root, selected.id) ?? fallback : fallback;
      setError(null);
      setSelectedPath(nextPath);
      onChange(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleDrop = (event: DragEvent, target: InsertionTarget): void => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    const source = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as NodePath;
    const planned = planCompositionOperation({
      config,
      catalog,
      payload: { type: "node", path: source },
      target,
    });
    if (planned.status !== "planned") setError(planned.message);
    else apply(() => planned.nextConfig, target.parentPath);
    setDragging(null);
  };

  const addButton = (target: InsertionTarget, label: string): ReactNode => (
    <button
      className="editor-drop-zone"
      type="button"
      onDragOver={(event) => {
        if (!dragging || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        const planned = planCompositionOperation({ config, catalog, payload: { type: "node", path: dragging }, target });
        if (planned.status === "planned") event.preventDefault();
      }}
      onDrop={(event) => handleDrop(event, target)}
      onClick={() => setAddTarget(target)}
    >+ {label}</button>
  );

  const renderNode = (node: ComponentNode, path: NodePath, root = false): ReactNode => {
    const manifest = catalogManifest(catalog, node.component);
    const definition = manifest?.children;
    const nodeSelected = pathEquals(path, effectiveSelectedPath);
    const isCollapsed = !root && collapsed.has(pathKey(path)) && childEdges(node.children).length > 0;
    const childCount = childEdges(node.children).length;
    const canAdd = Boolean(definition && (definition.max === undefined || childCount < definition.max));

    const renderLayout = (layout: ComponentChildLayout, layoutPath: LayoutBranch[] = []): ReactNode => {
      if (layout.type === "child") {
        const childPath = [...path, { type: "tiled" as const, path: layoutPath }];
        return (
          <div className="editor-tile" key={layout.child.node.id ?? pathKey(childPath)}>
            {renderNode(layout.child.node, childPath)}
            {canAdd && manifest ? (
              <div className="editor-tile__insertions">
                {tiledPlacements(manifest, layoutPath).map(({ label, placement }) => (
                  <span key={label}>{addButton({ parentPath: path, placement }, label)}</span>
                ))}
              </div>
            ) : null}
          </div>
        );
      }
      const ratio = normalizeSplitRatio(layout.ratio);
      return (
        <SplitLayout
          axis={layout.axis}
          first={renderLayout(layout.first, [...layoutPath, "first"])}
          second={renderLayout(layout.second, [...layoutPath, "second"])}
          ratio={ratio}
          defaultRatio={ratio}
          minFirstPx={DEFAULT_SPLIT_MIN_PX}
          minSecondPx={DEFAULT_SPLIT_MIN_PX}
          resizable={layout.axis === "horizontal"}
          label={`${manifest?.name ?? node.component} draft tiles`}
          onRatioChange={layout.axis === "horizontal"
            ? (next) => apply(() => updateTiledSplitRatio(config, path, layoutPath, next), path)
            : undefined}
        />
      );
    };

    let childrenPreview: ReactNode = null;
    if (!isCollapsed && node.children?.type === "tiled") {
      childrenPreview = renderLayout(node.children.layout);
    } else if (!isCollapsed && node.children?.type === "managed") {
      childrenPreview = (
        <div className="editor-managed-children">
          {canAdd ? addButton({
            parentPath: path,
            placement: { type: "managed", index: 0, metadata: manifest ? defaultChildMetadata(manifest, 0) : {} },
          }, "Add child") : null}
          {node.children.items.map((edge, index) => {
            const childPath = [...path, { type: "managed" as const, index }];
            const label = typeof edge.metadata?.label === "string" ? edge.metadata.label : null;
            return (
              <div className="editor-managed-child" key={edge.node.id ?? pathKey(childPath)}>
                {label ? <span className="editor-slot__label">{label}</span> : null}
                {renderNode(edge.node, childPath)}
                {canAdd ? addButton({
                  parentPath: path,
                  placement: { type: "managed", index: index + 1, metadata: manifest ? defaultChildMetadata(manifest, index + 1) : {} },
                }, "Add child here") : null}
              </div>
            );
          })}
        </div>
      );
    } else if (!isCollapsed && !node.children && canAdd && manifest) {
      const presentation = definition!.presentation;
      const placement: ComponentChildPlacement = presentation.type === "managed"
        ? { type: "managed", index: 0, metadata: defaultChildMetadata(manifest, 0) }
        : {
            type: "tiled",
            path: [],
            axis: presentation.axes === "vertical" ? "vertical" : "horizontal",
            position: "first",
          };
      childrenPreview = addButton({ parentPath: path, placement }, "Add first child");
    }

    return (
      <section className={`editor-node${root ? " editor-node--root" : ""}${nodeSelected ? " editor-node--selected" : ""}`} data-editor-node={pathKey(path)}>
        <header className="editor-node__toolbar">
          {!root ? (
            <button className="editor-node__drag" type="button" draggable aria-label={`Drag ${manifest?.name ?? node.component}`} onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(path));
              setDragging(path);
            }} onDragEnd={() => setDragging(null)}>⠿</button>
          ) : null}
          <button className="editor-node__select" type="button" aria-pressed={nodeSelected} onClick={() => setSelectedPath(path)}>
            <span className="editor-node__identity"><strong>{manifest?.name ?? node.component}</strong>{node.id ? <code>{node.id}</code> : null}</span>
            {isCollapsed ? <span className="editor-node__summary">{countNodes(node) - 1} nested</span> : null}
          </button>
          {!root && childCount > 0 ? (
            <button className="editor-node__collapse" type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(pathKey(path))) next.delete(pathKey(path)); else next.add(pathKey(path));
              return next;
            })}>{isCollapsed ? "Expand" : "Collapse"}</button>
          ) : null}
        </header>
        {!isCollapsed ? <div className="editor-node__preview"><div className="editor-component-preview"><code>{node.component}</code></div>{childrenPreview}</div> : null}
      </section>
    );
  };

  const configureNode = configurePath ? nodeAtPath(config.root, configurePath) : null;
  const removingNode = removePath ? nodeAtPath(config.root, removePath) : null;
  const selectedLocator = effectiveSelectedPath.at(-1);
  const selectedParentPath = effectiveSelectedPath.slice(0, -1);
  const selectedParent = selectedLocator ? nodeAtPath(config.root, selectedParentPath) : null;
  const managedSiblings = selectedLocator?.type === "managed" && selectedParent
    ? managedChildEdges(selectedParent) : [];

  return (
    <>
      {error ? <div className="global-error" role="alert"><strong>Edit failed</strong><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div> : null}
      <section className="dashboard-metadata-editor" aria-label="Dashboard details">
        <div className="dashboard-metadata-editor__fields">
          <label className="props-field"><span>Name<em>Required</em></span><input value={config.name} onChange={(event) => onChange(updateDashboardMetadata(config, "name", event.target.value))} /></label>
          <label className="props-field"><span>Sidebar icon</span><input value={config.icon ?? ""} onChange={(event) => onChange(updateDashboardMetadata(config, "icon", event.target.value))} /></label>
        </div>
      </section>
      {diagnostics.length ? <details className="editor-diagnostics" open={!valid}><summary>Draft validation</summary><ul>{diagnostics.map((item, index) => <li key={`${item.code}:${index}`}><code>{item.code}</code> {item.message}</li>)}</ul></details> : null}
      <div className="editor-workbench" role="region" aria-label="Selected component actions">
        <div className="editor-workbench__selection"><span>Selected component</span><strong>{selectedManifest?.name ?? selected.component}</strong>{selected.id ? <code>{selected.id}</code> : null}</div>
        <div className="editor-workbench__actions">
          {selectedLocator?.type === "managed" ? (
            <>
              <button className="editor-icon-button" type="button" disabled={selectedLocator.index === 0} onClick={() => {
                const planned = planCompositionOperation({
                  config, catalog, payload: { type: "node", path: effectiveSelectedPath },
                  target: { parentPath: selectedParentPath, placement: { type: "managed", index: selectedLocator.index - 1 } },
                });
                if (planned.status !== "planned") setError(planned.message);
                else apply(() => planned.nextConfig);
              }}>↑</button>
              <button className="editor-icon-button" type="button" disabled={selectedLocator.index >= managedSiblings.length - 1} onClick={() => {
                const planned = planCompositionOperation({
                  config, catalog, payload: { type: "node", path: effectiveSelectedPath },
                  target: { parentPath: selectedParentPath, placement: { type: "managed", index: selectedLocator.index + 2 } },
                });
                if (planned.status !== "planned") setError(planned.message);
                else apply(() => planned.nextConfig);
              }}>↓</button>
            </>
          ) : null}
          {effectiveSelectedPath.length === 0 ? <button className="button button--quiet" type="button" onClick={() => setReplaceOpen(true)}>Replace root</button> : null}
          <button className="button button--secondary" type="button" disabled={!selectedManifest} onClick={() => setConfigurePath(effectiveSelectedPath)}>Configure</button>
          {effectiveSelectedPath.length > 0 ? <button className="button button--quiet button--danger-quiet" type="button" onClick={() => setRemovePath(effectiveSelectedPath)}>Remove</button> : null}
        </div>
      </div>
      <section className={`dashboard dashboard--editing${dragging ? " dashboard--dragging" : ""}`} aria-label={`${config.name} dashboard editor`}>
        {renderNode(config.root, [], true)}
      </section>
      {addTarget ? <ComponentDialog catalog={catalog} config={config} target={addTarget} projectRoot={projectRoot} configPath={configPath} agentCommand={agentCommand} agentPending={agentPending} onBuildWithAgent={onBuildWithAgent} onApply={onChange} onDismiss={() => setAddTarget(null)} /> : null}
      {configurePath && configureNode ? <ComponentDialog catalog={catalog} config={config} existing={{ path: configurePath, node: configureNode }} onApply={onChange} onDismiss={() => setConfigurePath(null)} /> : null}
      {replaceOpen ? <ComponentDialog catalog={catalog} config={config} replace={config.root} onApply={(next) => { onChange(next); setSelectedPath([]); }} onDismiss={() => setReplaceOpen(false)} /> : null}
      {removePath && removingNode ? (
        <EditorModal title="Remove component?" onDismiss={() => setRemovePath(null)}>
          <div className="remove-confirmation">
            <p>Remove <strong>{catalogManifest(catalog, removingNode.component)?.name ?? removingNode.component}</strong>?</p>
            {countNodes(removingNode) > 1 ? <p>This also removes {countNodes(removingNode) - 1} nested components.</p> : null}
            <p>The change remains recoverable until you save the dashboard.</p>
            <footer className="editor-modal__actions">
              <button className="button button--quiet" type="button" onClick={() => setRemovePath(null)}>Cancel</button>
              <button className="button button--danger" type="button" onClick={() => {
                apply(() => removeNode(config, removePath, catalog), removePath.slice(0, -1));
                setRemovePath(null);
              }}>Remove</button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
    </>
  );
}
