import { useState } from "react";
import type { ReactNode } from "react";
import type {
  ComponentCatalogItem,
  ComponentNode,
  DashboardConfig,
} from "../../shared/contracts";
import { childLocators, edgeAtLocator } from "../lib/component-children";
import { EditorModal } from "../lib/editor-modal";
import { PERMISSION_LABELS } from "../lib/action-providers";
import {
  catalogManifest,
  countDiscardedRootNodes,
  generateNodeId,
  nodeAtPath,
  nodePathById,
  pathEquals,
  pathKey,
  updateChildMetadata,
  updateNodeProps,
  updateNodePersistOnFocus,
  type InsertionTarget,
  type NodePath,
} from "./dashboard-editor";
import { planCompositionOperation } from "./composition-operation";
import { isLegacyActionTarget } from "../../migrations/action-target";

function nextActionTargetId(config: DashboardConfig, node: ComponentNode): string {
  const used = new Set<string>();
  const collect = (current: ComponentNode): void => {
    if (current.id) used.add(current.id);
    for (const locator of childLocators(current.children)) collect(edgeAtLocator(current.children, locator).node);
  };
  collect(config.root);
  const base = (node.component.split("/").at(-1) ?? "target").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "target";
  let candidate = `${base}-target`;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-target-${suffix++}`;
  return candidate;
}

function withActionTargetId(config: DashboardConfig, path: NodePath | undefined, id: string | undefined): DashboardConfig {
  if (!path || !id) return config;
  const next = structuredClone(config);
  const target = nodeAtPath(next.root, path);
  if (!target.id) target.id = id;
  return next;
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
  const [fieldError, setFieldError] = useState<{ name: string; value: unknown; message: string } | null>(null);
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
          if (property.format === "action-reference" && typeof nextValue === "string" && isLegacyActionTarget(nextValue)) {
            setFieldError({
              name,
              value: current,
              message: "Use a stable node ID. Positional references are kept only for existing schema-v3 dashboards.",
            });
            return;
          }
          setFieldError(null);
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
            {property.format === "action-reference" && ((fieldError?.name === name && fieldError.value === current) || (typeof current === "string" && isLegacyActionTarget(current)))
              ? <small className="inline-warning" role="status">{fieldError?.name === name && fieldError.value === current ? fieldError.message : "Use the stable target picker to replace this legacy positional reference."}</small>
              : null}
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
  const [persistOnFocus, setPersistOnFocus] = useState(current?.persistOnFocus === true);
  const [metadata, setMetadata] = useState<Record<string, unknown>>(() => {
    if (!existing || existing.path.length === 0) return target?.placement.metadata ?? {};
    const parent = nodeAtPath(config.root, existing.path.slice(0, -1));
    return edgeAtLocator(parent.children, existing.path.at(-1)!).metadata ?? {};
  });
  const [applyError, setApplyError] = useState<string | null>(null);
  const [actionTargetPath, setActionTargetPath] = useState<NodePath | null>(null);
  const [actionKind, setActionKind] = useState<"focus" | "component">("focus");
  const [localActionId, setLocalActionId] = useState("refresh");
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
  const actionTargets: { path: NodePath; node: ComponentNode }[] = [];
  const collectActionTargets = (node: ComponentNode, path: NodePath): void => {
    actionTargets.push({ path, node });
    for (const locator of childLocators(node.children)) {
      collectActionTargets(edgeAtLocator(node.children, locator).node, [...path, locator]);
    }
  };
  collectActionTargets(config.root, []);
  const selectedActionTarget = actionTargetPath
    ? actionTargets.find((entry) => pathEquals(entry.path, actionTargetPath))
    : undefined;
  const proposedTargetId = selectedActionTarget?.node.id ?? (selectedActionTarget
    ? nextActionTargetId(config, selectedActionTarget.node)
    : undefined);

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
          <input className="component-picker__search" type="search" aria-label="Search components" placeholder="Search or describe a component…" value={query} onChange={(event) => setQuery(event.target.value)} />
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
          if (item.reference === "./components/external/core/button" && typeof props.action === "string" && isLegacyActionTarget(props.action)) {
            setApplyError("Choose a stable target ID before applying this action button.");
            return;
          }
          if (replace) {
            const planned = planCompositionOperation({
              config: withActionTargetId(config, selectedActionTarget?.path, proposedTargetId),
              catalog,
              payload: { type: "component", reference: item.reference, props },
              target: { type: "root-replacement", path: [] },
            });
            if (planned.status !== "planned") {
              setApplyError(planned.message);
              return;
            }
            onApply(updateNodePersistOnFocus(planned.nextConfig, [], persistOnFocus));
          } else if (existing) {
            let next = withActionTargetId(config, selectedActionTarget?.path, proposedTargetId);
            next = updateNodeProps(next, existing.path, props);
            next = updateNodePersistOnFocus(next, existing.path, persistOnFocus);
            if (existing.path.length > 0 && metadataSchema) next = updateChildMetadata(next, existing.path, metadata);
            onApply(next);
          } else if (target) {
            const sourceConfig = withActionTargetId(config, selectedActionTarget?.path, proposedTargetId);
            const planned = planCompositionOperation({
              config: sourceConfig,
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
            const createdId = generateNodeId(config, item.manifest!);
            const createdPath = nodePathById(planned.nextConfig.root, createdId);
            onApply(createdPath
              ? updateNodePersistOnFocus(planned.nextConfig, createdPath, persistOnFocus)
              : planned.nextConfig);
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
          {item.reference === "./components/external/core/button" ? (
            <fieldset className="action-target-picker">
              <legend>Stable action target</legend>
              <label className="props-field"><span>Target node</span>
                <select value={actionTargetPath ? pathKey(actionTargetPath) : ""} onChange={(event) => {
                  const entry = actionTargets.find((candidate) => pathKey(candidate.path) === event.target.value);
                  setActionTargetPath(entry?.path ?? null);
                }}>
                  <option value="">Choose a target</option>
                  {actionTargets.map(({ path, node }) => <option key={pathKey(path)} value={pathKey(path)}>
                    {catalogManifest(catalog, node.component)?.name ?? node.component}{node.id ? ` · ${node.id}` : " · ID assigned on apply"}
                  </option>)}
                </select>
              </label>
              <label className="props-field"><span>Action type</span>
                <select value={actionKind} onChange={(event) => setActionKind(event.target.value as "focus" | "component")}>
                  <option value="focus">Focus node</option>
                  <option value="component">Component action</option>
                </select>
              </label>
              {actionKind === "component" ? <label className="props-field"><span>Local action ID</span>
                <input value={localActionId} onChange={(event) => setLocalActionId(event.target.value)} />
              </label> : null}
              <button className="button button--quiet" type="button" disabled={!proposedTargetId || (actionKind === "component" && !localActionId.trim())} onClick={() => {
                if (!proposedTargetId) return;
                const reference = actionKind === "focus"
                  ? `focus:${encodeURIComponent(proposedTargetId)}`
                  : `component:${encodeURIComponent(proposedTargetId)}:${encodeURIComponent(localActionId.trim())}`;
                setProps({ ...props, action: reference });
              }}>Use selected target</button>
            </fieldset>
          ) : null}
          <SchemaEditor schema={item.manifest.propsSchema} value={props} onChange={setProps} label="Component props" />
          <label className="props-field props-field--checkbox">
            <input type="checkbox" checked={persistOnFocus} onChange={(event) => setPersistOnFocus(event.target.checked)} />
            <span>Keep visible around focused components</span>
          </label>
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
