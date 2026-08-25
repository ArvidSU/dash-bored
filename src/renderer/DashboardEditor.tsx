import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  Diagnostic,
  ResolvedComponentNode,
} from "../shared/contracts";
import { PERMISSION_LABELS } from "./action-providers";
import { BuiltinRenderer } from "./builtins";
import { host } from "./rpc-client";
import {
  catalogManifest,
  collapsibleNodePaths,
  countNodes,
  countDiscardedRootNodes,
  createNode,
  insertNode,
  moveNode,
  nodeAtPath,
  nodePathById,
  pathEquals,
  pathKey,
  removeNode,
  replaceRoot as replaceRootNode,
  slotAcceptsMultiple,
  slotChildren,
  slotNames,
  tabLabels,
  updateDashboardMetadata,
  updateNodeProps,
  type NodePath,
  type SlotTarget,
} from "./dashboard-editor";

const DRAG_TYPE = "application/x-dash-bored-node";

type EditorIconName = "drag" | "settings" | "remove" | "up" | "down" | "add";

function EditorIcon({ name }: { name: EditorIconName }): ReactNode {
  if (name === "add") return <span aria-hidden="true">+</span>;
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {name === "drag" ? (
        <><circle cx="7" cy="6" r="1" /><circle cx="13" cy="6" r="1" /><circle cx="7" cy="10" r="1" /><circle cx="13" cy="10" r="1" /><circle cx="7" cy="14" r="1" /><circle cx="13" cy="14" r="1" /></>
      ) : name === "settings" ? (
        <><path d="M12.22 2h-.44a2 2 0 0 0-1.99 1.67l-.06.36a2 2 0 0 1-2.99 1.4l-.31-.18a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.31.18a2 2 0 0 1 0 3.46l-.31.18a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.31-.18a2 2 0 0 1 2.99 1.4l.06.36A2 2 0 0 0 10 20h.44a2 2 0 0 0 1.99-1.67l.06-.36a2 2 0 0 1 2.99-1.4l.31.18a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.31-.18a2 2 0 0 1 0-3.46l.31-.18a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.31.18a2 2 0 0 1-2.99-1.4l-.06-.36A2 2 0 0 0 12.22 2Z" /><circle cx="12" cy="12" r="3" /></>
      ) : name === "remove" ? (
        <><path d="M5 6h10M8 6V4h4v2M7 8l.6 8h4.8l.6-8" /></>
      ) : name === "up" ? (
        <path d="m5 12 5-5 5 5" />
      ) : (
        <path d="m5 8 5 5 5-5" />
      )}
    </svg>
  );
}

interface ModalProps {
  title: string;
  children: ReactNode;
  onDismiss: () => void;
}

const openEditorModals: symbol[] = [];

export function EditorModal({ title, children, onDismiss }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const modalToken = useRef(Symbol("editor-modal"));
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = modalToken.current;
    openEditorModals.push(token);
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = panel?.querySelector<HTMLElement>("[data-modal-autofocus]")
        ?? panel?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled):not([data-modal-close])");
      target?.focus();
    });
    const close = (event: globalThis.KeyboardEvent): void => {
      if (openEditorModals.at(-1) !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onDismiss();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hidden);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      const index = openEditorModals.lastIndexOf(token);
      if (index >= 0) openEditorModals.splice(index, 1);
      previous?.focus();
    };
  }, [onDismiss]);
  return (
    <div className="editor-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onDismiss();
    }}>
      <div className="editor-modal__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <header className="editor-modal__header">
          <h2 id={titleId}>{title}</h2>
          <button className="editor-icon-button" data-modal-close type="button" aria-label="Close" onClick={onDismiss}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function schemaProperties(manifest: ComponentManifest): Record<string, Record<string, unknown>> {
  const value = manifest.propsSchema.properties;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Record<string, unknown>>
    : {};
}

function requiredProperties(manifest: ComponentManifest): Set<string> {
  return new Set(Array.isArray(manifest.propsSchema.required)
    ? manifest.propsSchema.required.filter((value): value is string => typeof value === "string")
    : []);
}

function simpleProperty(schema: Record<string, unknown>): boolean {
  return Array.isArray(schema.enum) || ["string", "number", "integer", "boolean"].includes(String(schema.type));
}

function initialProps(manifest: ComponentManifest, current: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(current);
  for (const [name, schema] of Object.entries(schemaProperties(manifest))) {
    if (!(name in next) && "default" in schema) next[name] = structuredClone(schema.default);
  }
  return next;
}

interface PropsEditorProps {
  manifest: ComponentManifest;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onSyntaxValid: (valid: boolean) => void;
  hiddenProperties?: readonly string[];
}

function PropsEditor({ manifest, value, onChange, onSyntaxValid, hiddenProperties = [] }: PropsEditorProps): ReactNode {
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(value, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const properties = schemaProperties(manifest);
  const visibleProperties = Object.entries(properties).filter(([name]) => !hiddenProperties.includes(name));
  const required = requiredProperties(manifest);
  const complex = visibleProperties.filter(([, schema]) => !simpleProperty(schema));

  function changeProperty(name: string, schema: Record<string, unknown>, raw: string | boolean): void {
    const next = { ...value };
    if (Array.isArray(schema.enum)) next[name] = schema.enum.find((option) => String(option) === raw);
    else if (schema.type === "boolean") next[name] = raw;
    else if ((schema.type === "number" || schema.type === "integer") && raw !== "") next[name] = Number(raw);
    else if (raw === "" && !required.has(name)) delete next[name];
    else next[name] = raw;
    onChange(next);
  }

  if (advanced) {
    return (
      <div className="props-editor">
        <div className="props-editor__heading">
          <span>Props JSON</span>
          <button className="button button--quiet" type="button" onClick={() => {
            try {
              const parsed = JSON.parse(json) as unknown;
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Props must be a JSON object.");
              onChange(parsed as Record<string, unknown>);
              setJsonError(null);
              onSyntaxValid(true);
              setAdvanced(false);
            } catch (error) {
              setJsonError(error instanceof Error ? error.message : String(error));
              onSyntaxValid(false);
            }
          }}>Use fields</button>
        </div>
        <textarea
          className="props-editor__json"
          aria-label="Component props JSON"
          spellCheck={false}
          value={json}
          onChange={(event) => {
            const source = event.target.value;
            setJson(source);
            try {
              const parsed = JSON.parse(source) as unknown;
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Props must be a JSON object.");
              setJsonError(null);
              onSyntaxValid(true);
              onChange(parsed as Record<string, unknown>);
            } catch (error) {
              setJsonError(error instanceof Error ? error.message : String(error));
              onSyntaxValid(false);
            }
          }}
        />
        {jsonError ? <p className="inline-error" role="alert">{jsonError}</p> : null}
      </div>
    );
  }

  return (
    <div className="props-editor">
      {visibleProperties.map(([name, schema], index) => {
        const label = typeof schema.title === "string" ? schema.title : name;
        const description = typeof schema.description === "string" ? schema.description : null;
        if (!simpleProperty(schema)) return null;
        return (
          <label className="props-field" key={name}>
            <span>{label}{required.has(name) ? <em>Required</em> : null}</span>
            {Array.isArray(schema.enum) ? (
              <select data-modal-autofocus={index === 0 ? "true" : undefined} value={value[name] === undefined ? "" : String(value[name])} onChange={(event) => changeProperty(name, schema, event.target.value)}>
                {value[name] === undefined && required.has(name) ? <option value="" disabled>Select…</option> : null}
                {!required.has(name) ? <option value="">Not set</option> : null}
                {schema.enum.map((option) => <option value={String(option)} key={String(option)}>{String(option)}</option>)}
              </select>
            ) : schema.type === "boolean" ? (
              <input data-modal-autofocus={index === 0 ? "true" : undefined} type="checkbox" checked={value[name] === true} onChange={(event) => changeProperty(name, schema, event.target.checked)} />
            ) : (
              <input
                data-modal-autofocus={index === 0 ? "true" : undefined}
                type={schema.type === "number" || schema.type === "integer" ? "number" : "text"}
                step={schema.type === "integer" ? 1 : "any"}
                value={value[name] === undefined ? "" : String(value[name])}
                onChange={(event) => changeProperty(name, schema, event.target.value)}
              />
            )}
            {description ? <small>{description}</small> : null}
          </label>
        );
      })}
      {visibleProperties.length === 0 ? <p className="editor-muted">This component has no configurable props.</p> : null}
      {complex.length > 0 ? <p className="editor-muted">{complex.map(([name]) => name).join(", ")} use the JSON editor.</p> : null}
      <button className="button button--quiet" type="button" onClick={() => {
        setJson(JSON.stringify(value, null, 2));
        setJsonError(null);
        onSyntaxValid(true);
        setAdvanced(true);
      }}>Advanced JSON</button>
    </div>
  );
}

interface TabsConfigEditorProps {
  node: ComponentNode;
  props: Record<string, unknown>;
  catalog: readonly ComponentCatalogItem[];
  onAddTab: () => void;
  onRemoveTab: (index: number) => void;
  onRenameTab: (index: number, label: string) => void;
}

function TabsConfigEditor({ node, props, catalog, onAddTab, onRemoveTab, onRenameTab }: TabsConfigEditorProps): ReactNode {
  const labels = tabLabels({ ...node, props });
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  useEffect(() => setDrafts({}), [node, props]);

  function commit(index: number): void {
    const draft = drafts[index];
    if (draft === undefined) return;
    const next = draft.trim();
    if (next && next !== labels[index]) onRenameTab(index, next);
    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[index];
      return nextDrafts;
    });
  }

  return (
    <div className="tabs-config-editor">
      <div className="tabs-config-editor__heading">
        <div>
          <strong>Tabs</strong>
          <span>Set each panel name and manage the tab contents.</span>
        </div>
        <button className="button button--quiet" type="button" onClick={onAddTab}>Add tab</button>
      </div>
      <div className="tabs-config-editor__list" aria-label="Tab configuration">
        {labels.map((label, index) => {
          const value = drafts[index] ?? label;
          return (
            <div className="tabs-config-editor__row" key={index}>
              <label>
                <span>Tab {index + 1} name</span>
                <input
                  data-modal-autofocus={index === 0 ? "true" : undefined}
                  type="text"
                  aria-label={`Name tab ${index + 1}`}
                  value={value}
                  onChange={(event) => setDrafts((current) => ({ ...current, [index]: event.target.value }))}
                  onBlur={() => commit(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <div className="tabs-config-editor__content">
                <span>Content</span>
                <strong>{catalogManifest(catalog, slotChildren(node, "children")[index]?.component ?? "")?.name ?? slotChildren(node, "children")[index]?.component}</strong>
              </div>
              <button className="button button--quiet" type="button" aria-label={`Remove tab ${label}`} onClick={() => onRemoveTab(index)}>Remove tab</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ComponentDialogProps {
  catalog: readonly ComponentCatalogItem[];
  config: DashboardConfig;
  target?: SlotTarget;
  existing?: { path: NodePath; node: ComponentNode };
  replaceRoot?: ComponentNode;
  onApply: (next: DashboardConfig) => void;
  onDismiss: () => void;
}

function ComponentDialog({ catalog, config, target, existing, replaceRoot, onApply, onDismiss }: ComponentDialogProps): ReactNode {
  const existingItem = existing
    ? catalog.find((item) => item.reference === existing.node.component)
    : undefined;
  const currentNode = existing?.node ?? replaceRoot;
  const [query, setQuery] = useState("");
  const [selectedReference, setSelectedReference] = useState(replaceRoot ? "" : existingItem?.reference ?? "");
  const selected = catalog.find((item) => item.reference === selectedReference);
  const targetParent = target ? nodeAtPath(config.root, target.parentPath) : null;
  const addingTab = target?.slot === "children" && targetParent?.component === "@dash-bored/tabs";
  const isTabs = existing?.node.component === "@dash-bored/tabs";
  const [tabDraftConfig, setTabDraftConfig] = useState(config);
  const [tabAddOpen, setTabAddOpen] = useState(false);
  const [tabRemoveIndex, setTabRemoveIndex] = useState<number | null>(null);
  const [props, setProps] = useState<Record<string, unknown>>(() =>
    selected?.manifest
      ? initialProps(selected.manifest, currentNode?.component === selected.reference ? currentNode.props ?? {} : {})
      : {},
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [validatingProps, setValidatingProps] = useState(Boolean(selected?.manifest));
  const [propsSyntaxValid, setPropsSyntaxValid] = useState(true);
  const available = catalog.filter((item) => {
    const haystack = `${item.manifest?.name ?? item.reference} ${item.reference} ${item.manifest?.description ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  useEffect(() => {
    if (!selected?.manifest) return;
    setValidatingProps(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void host.validateComponentProps(selected.reference, props)
        .then((validation) => {
          if (!cancelled) {
            setSchemaError(validation.ok ? null : validation.diagnostics[0]?.message ?? "Props are invalid.");
            setValidatingProps(false);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setSchemaError(error instanceof Error ? error.message : String(error));
            setValidatingProps(false);
          }
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props, selected]);

  const choose = (item: ComponentCatalogItem): void => {
    if (!item.available || item.manifest === null) return;
    setSelectedReference(item.reference);
    setProps(initialProps(item.manifest, currentNode?.component === item.reference ? currentNode.props ?? {} : {}));
    setSchemaError(null);
    setValidatingProps(true);
    setPropsSyntaxValid(true);
  };

  const updateProps = (nextProps: Record<string, unknown>): void => {
    setProps(nextProps);
    if (isTabs && existing) {
      setTabDraftConfig((current) => updateNodeProps(current, existing.path, nextProps));
    }
  };

  const applyTabDraft = (next: DashboardConfig): void => {
    setTabDraftConfig(next);
    if (existing) setProps(nodeAtPath(next.root, existing.path).props ?? {});
  };

  const tabsNode = isTabs && existing ? nodeAtPath(tabDraftConfig.root, existing.path) : null;
  const tabsNodeForProps = tabsNode ? { ...tabsNode, props } : null;
  const tabLabelsForProps = tabsNodeForProps ? tabLabels(tabsNodeForProps) : [];

  const confirmTabRemoval = (): void => {
    if (!tabsNode || !existing || tabRemoveIndex === null) return;
    applyTabDraft(removeNode(
      tabDraftConfig,
      [...existing.path, { slot: "children", index: tabRemoveIndex }],
      catalog,
    ));
    setTabRemoveIndex(null);
  };

  return (
    <>
      <EditorModal title={replaceRoot ? "Replace dashboard root" : existing ? `Configure ${existingItem?.manifest?.name ?? existing.node.component}` : addingTab ? "Add tab" : "Add component"} onDismiss={onDismiss}>
      {!existing && !selected ? (
        <div className="component-picker">
          <input className="component-picker__search" data-modal-autofocus type="search" placeholder="Search components…" aria-label="Search components" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="component-picker__list">
            {available.map((item) => (
              <button className="component-picker__item" type="button" key={item.reference} disabled={!item.available || item.manifest === null} onClick={() => choose(item)}>
                <span><strong>{item.manifest?.name ?? item.reference}</strong><code>{item.reference}</code></span>
                <span>{item.manifest?.description ?? item.diagnostics[0]?.message ?? "Unavailable component"}</span>
                {item.manifest?.permissions?.length ? <small>{item.manifest.permissions.map((permission) => PERMISSION_LABELS[permission]).join(" · ")}</small> : null}
              </button>
            ))}
            {available.length === 0 ? <p className="editor-muted">No matching components.</p> : null}
          </div>
        </div>
      ) : selected?.manifest ? (
        <form className="component-config" onSubmit={(event) => {
          event.preventDefault();
          if (schemaError || validatingProps || !propsSyntaxValid) return;
          const next = existing
            ? updateNodeProps(isTabs ? tabDraftConfig : config, existing.path, props)
            : replaceRoot
              ? replaceRootNode(config, selected, props)
            : insertNode(config, target!, createNode(config, selected, props), catalog);
          onApply(next);
          onDismiss();
        }}>
          <div className="component-config__identity">
            <div><strong>{selected.manifest.name}</strong><code>{selected.reference}</code></div>
            {!existing ? <button className="button button--quiet" type="button" onClick={() => setSelectedReference("")}>Choose another</button> : null}
          </div>
          <p>{selected.manifest.description}</p>
          {replaceRoot ? (() => {
            const discarded = countDiscardedRootNodes(config, selected);
            return discarded > 0 ? (
              <p className="inline-warning">
                This replacement will remove {discarded} nested {discarded === 1 ? "component" : "components"} from the draft because the selected root cannot accommodate them.
              </p>
            ) : null;
          })() : null}
          {selected.manifest.permissions?.length ? (
            <div className="component-config__permissions"><strong>Capabilities</strong>{selected.manifest.permissions.map((permission) => <span key={permission}>{PERMISSION_LABELS[permission]}</span>)}</div>
          ) : null}
          {isTabs && tabsNode ? (
            <>
              <TabsConfigEditor
                node={tabsNode}
                props={props}
                catalog={catalog}
                onAddTab={() => setTabAddOpen(true)}
                onRemoveTab={setTabRemoveIndex}
                onRenameTab={(index, label) => {
                  const labels = tabLabelsForProps;
                  labels[index] = label;
                  updateProps({ ...props, labels });
                }}
              />
              {tabRemoveIndex !== null && tabsNodeForProps ? (
                <div className="tabs-config-editor__confirmation" role="alert">
                  <p>Remove the <strong>{tabLabelsForProps[tabRemoveIndex]}</strong> tab and its content?</p>
                  <div>
                    <button className="button button--quiet" type="button" onClick={() => setTabRemoveIndex(null)}>Cancel</button>
                    <button className="button button--danger" type="button" onClick={confirmTabRemoval}>Remove tab</button>
                  </div>
                </div>
              ) : null}
              <PropsEditor
                manifest={selected.manifest}
                value={props}
                onChange={updateProps}
                onSyntaxValid={setPropsSyntaxValid}
                hiddenProperties={["labels"]}
              />
            </>
          ) : (
            <PropsEditor manifest={selected.manifest} value={props} onChange={setProps} onSyntaxValid={setPropsSyntaxValid} />
          )}
          {schemaError ? <p className="inline-error" role="alert">{schemaError}</p> : null}
          <footer className="editor-modal__actions">
            <button className="button button--quiet" type="button" onClick={onDismiss}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={Boolean(schemaError) || validatingProps || !propsSyntaxValid}>{validatingProps ? "Validating…" : replaceRoot ? "Replace root" : existing ? "Apply" : addingTab ? "Add tab" : "Add component"}</button>
          </footer>
        </form>
      ) : (
        <div className="component-config"><p className="inline-error">This component is no longer available.</p></div>
      )}
      </EditorModal>
      {tabAddOpen && isTabs && existing && tabsNode ? (
        <ComponentDialog
          catalog={catalog}
          config={tabDraftConfig}
          target={{ parentPath: existing.path, slot: "children", index: slotChildren(tabsNode, "children").length }}
          onApply={(next) => {
            applyTabDraft(next);
            setTabAddOpen(false);
          }}
          onDismiss={() => setTabAddOpen(false)}
        />
      ) : null}
    </>
  );
}

export interface DashboardEditorToolbarProps {
  diagnostics: readonly Diagnostic[];
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export function DashboardEditorToolbar({
  diagnostics,
  saving,
  dirty,
  onSave,
  onCancel,
}: DashboardEditorToolbarProps): ReactNode {
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

interface DashboardMetadataEditorProps {
  config: DashboardConfig;
  onChange: (config: DashboardConfig) => void;
}

function DashboardMetadataEditor({ config, onChange }: DashboardMetadataEditorProps): ReactNode {
  return (
    <section className="dashboard-metadata-editor" aria-label="Dashboard details">
      <header className="dashboard-metadata-editor__header">
        <div>
          <span className="eyebrow">Dashboard</span>
          <h2>Identity</h2>
        </div>
        <p>These details are saved with the dashboard configuration.</p>
      </header>
      <div className="dashboard-metadata-editor__fields">
        <label className="props-field">
          <span>Name<em>Required</em></span>
          <input
            type="text"
            value={config.name}
            onChange={(event) => onChange(updateDashboardMetadata(config, "name", event.target.value))}
          />
          <small>Shown in the sidebar and window title.</small>
        </label>
        <label className="props-field">
          <span>Sidebar icon</span>
          <input
            type="text"
            spellCheck={false}
            placeholder="./assets/icon.svg or https://…"
            value={config.icon ?? ""}
            onChange={(event) => onChange(updateDashboardMetadata(config, "icon", event.target.value))}
          />
          <small>Use a relative or absolute image path, or an HTTP(S) URL. Leave blank for the default icon.</small>
        </label>
      </div>
    </section>
  );
}

interface DashboardEditorProps {
  config: DashboardConfig;
  catalog: readonly ComponentCatalogItem[];
  diagnostics: readonly Diagnostic[];
  onChange: (config: DashboardConfig) => void;
}

export function DashboardEditor({
  config,
  catalog,
  diagnostics,
  onChange,
}: DashboardEditorProps): ReactNode {
  const [addTarget, setAddTarget] = useState<SlotTarget | null>(null);
  const [configurePath, setConfigurePath] = useState<NodePath | null>(null);
  const [replaceRootOpen, setReplaceRootOpen] = useState(false);
  const [removePath, setRemovePath] = useState<NodePath | null>(null);
  const [dragging, setDragging] = useState<NodePath | null>(null);
  const [selectedPath, setSelectedPath] = useState<NodePath>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(
    collapsibleNodePaths(config.root)
      .filter((path) => path.length > 0)
      .map(pathKey),
  ));
  const [editorError, setEditorError] = useState<string | null>(null);
  const valid = diagnostics.every((item) => item.severity !== "error");

  let effectiveSelectedPath = selectedPath;
  let selectedNode: ComponentNode;
  try {
    selectedNode = nodeAtPath(config.root, selectedPath);
  } catch {
    effectiveSelectedPath = [];
    selectedNode = config.root;
  }

  const selectedManifest = catalogManifest(catalog, selectedNode.component);
  const selectedName = selectedManifest?.name ?? selectedNode.component;
  const selectedSegment = effectiveSelectedPath.at(-1);
  const selectedParentPath = effectiveSelectedPath.slice(0, -1);
  const selectedParent = selectedSegment ? nodeAtPath(config.root, selectedParentPath) : null;
  const selectedSiblings = selectedParent && selectedSegment
    ? slotChildren(selectedParent, selectedSegment.slot)
    : [config.root];
  const selectedCanReorder = Boolean(
    selectedParent &&
    selectedSegment &&
    slotAcceptsMultiple(catalog, selectedParent, selectedSegment.slot),
  );
  const collapsiblePaths = collapsibleNodePaths(config.root).filter((path) => path.length > 0);
  const allCollapsed = collapsiblePaths.every((path) => collapsed.has(pathKey(path)));

  const applyDraft = (next: DashboardConfig, fallbackPath = effectiveSelectedPath): void => {
    const nextSelection = selectedNode.id
      ? nodePathById(next.root, selectedNode.id) ?? fallbackPath
      : fallbackPath;
    onChange(next);
    setSelectedPath(nextSelection);
  };

  const apply = (operation: () => DashboardConfig, fallbackPath = effectiveSelectedPath): void => {
    try {
      setEditorError(null);
      applyDraft(operation(), fallbackPath);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleCollapsed = (path: NodePath): void => {
    const key = pathKey(path);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderDropZone = (target: SlotTarget, empty: boolean): ReactNode => (
    <div
      className={`editor-drop-zone${empty ? " editor-drop-zone--empty" : ""}${dragging ? " editor-drop-zone--dragging" : ""}`}
      data-slot={target.slot}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sourceText = event.dataTransfer.getData(DRAG_TYPE);
        if (!sourceText) return;
        apply(() => moveNode(config, JSON.parse(sourceText) as NodePath, target, catalog), target.parentPath);
        setDragging(null);
      }}
    >
      <button type="button" aria-label={`Add component to ${target.slot}`} onClick={() => setAddTarget(target)}>
        <EditorIcon name="add" />
        <span>{empty ? "Add component" : "Add here"}</span>
      </button>
    </div>
  );

  const renderSlot = (parent: ComponentNode, parentPath: NodePath, slot: string): ReactNode => {
    const children = slotChildren(parent, slot);
    const multiple = slotAcceptsMultiple(catalog, parent, slot);
    const implicit = slot === "children" && slotNames(catalog, parent).length === 1;
    return (
      <div className={`editor-slot${implicit ? " editor-slot--implicit" : ""}${children.length === 0 ? " editor-slot--empty" : ""}`} data-slot={slot} key={slot}>
        {!implicit ? <span className="editor-slot__label">{slot}</span> : null}
        {multiple || children.length === 0
          ? renderDropZone({ parentPath, slot, index: 0 }, children.length === 0)
          : null}
        {children.map((child, index) => {
          const childPath = [...parentPath, { slot, index }];
          return (
            <div className="editor-slot__child" key={child.id ?? `${pathKey(childPath)}:${child.component}`}>
              {renderNode(child, childPath, false)}
              {multiple ? renderDropZone({ parentPath, slot, index: index + 1 }, false) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const renderNode = (
    node: ComponentNode,
    path: NodePath,
    root: boolean,
  ): ReactNode => {
    const manifest = catalogManifest(catalog, node.component);
    const name = manifest?.name ?? node.component;
    const configuredSlots = slotNames(catalog, node);
    const key = pathKey(path);
    const selected = pathEquals(path, effectiveSelectedPath);
    const collapsible = configuredSlots.some((slot) => slotChildren(node, slot).length > 0);
    const isCollapsed = !root && collapsible && collapsed.has(key);
    const resolvedNode: ResolvedComponentNode = {
      id: node.id ?? pathKey(path),
      component: node.component,
      props: node.props ?? {},
      slots: {},
      source: node.component.startsWith("./components/") ? "local" : "builtin",
      ...(node.component.startsWith("./components/") && manifest ? { manifest } : {}),
    };
    let preview: ReactNode;
    if (node.component === "@dash-bored/stack") {
      preview = <div className={`stack stack--${String(node.props?.gap ?? "medium")}`}>{configuredSlots.map((slot) => renderSlot(node, path, slot))}</div>;
    } else if (node.component === "@dash-bored/card") {
      preview = <section className="card"><header className="card__header"><h2>{String(node.props?.title ?? "Card")}</h2>{node.props?.description ? <p>{String(node.props.description)}</p> : null}</header><div className="card__body">{configuredSlots.map((slot) => renderSlot(node, path, slot))}</div></section>;
    } else if (node.component === "@dash-bored/split") {
      preview = <div className={`split split--${node.props?.direction === "vertical" ? "vertical" : "horizontal"}`}>{configuredSlots.map((slot) => <div className="split__pane" key={slot}>{renderSlot(node, path, slot)}</div>)}</div>;
    } else if (node.component === "@dash-bored/tabs") {
      preview = <div className="editor-tabs"><div className="tabs__list">{tabLabels(node).map((label, index) => <span className="tabs__tab" key={`${label}:${index}`}>{label}</span>)}</div>{renderSlot(node, path, "children")}</div>;
    } else if (["@dash-bored/text", "@dash-bored/markdown", "@dash-bored/status"].includes(node.component)) {
      preview = <BuiltinRenderer node={resolvedNode} slots={{}} trusted={false} processes={new Map()} />;
    } else {
      const previewKind = node.component.startsWith("./components/")
        ? "Local component"
        : node.component.startsWith("@dash-bored/")
          ? "Component preview"
          : "Linked dashboard";
      preview = <div className="editor-component-preview"><span>{previewKind}</span><code>{node.component}</code>{configuredSlots.map((slot) => renderSlot(node, path, slot))}</div>;
    }

    return (
      <section className={`editor-node${root ? " editor-node--root" : ""}${selected ? " editor-node--selected" : ""}${isCollapsed ? " editor-node--collapsed" : ""}`} data-editor-node={key}>
        <header className="editor-node__toolbar">
          {!root ? (
            <button
              className="editor-node__drag"
              type="button"
              draggable
              aria-label={`Drag ${name}`}
              title="Drag component"
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(path));
                event.dataTransfer.effectAllowed = "move";
                setDragging(path);
                setSelectedPath(path);
              }}
              onDragEnd={() => setDragging(null)}
            ><EditorIcon name="drag" /></button>
          ) : null}
          <button className="editor-node__select" type="button" aria-pressed={selected} onClick={() => setSelectedPath(path)}>
            <span className="editor-node__identity"><strong>{name}</strong>{node.id ? <code>{node.id}</code> : null}</span>
            {isCollapsed ? <span className="editor-node__summary">{countNodes(node) - 1} nested</span> : null}
          </button>
          {!root && collapsible ? (
            <button className="editor-node__collapse" type="button" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${name}`} aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(path)}>
              <EditorIcon name={isCollapsed ? "down" : "up"} />
            </button>
          ) : null}
        </header>
        {!isCollapsed ? <div className="editor-node__preview">{preview}</div> : null}
      </section>
    );
  };

  const removing = removePath ? nodeAtPath(config.root, removePath) : null;
  const removingParent = removePath ? nodeAtPath(config.root, removePath.slice(0, -1)) : null;
  const removingSegment = removePath?.at(-1);
  const removingTab = Boolean(
    removingParent?.component === "@dash-bored/tabs" &&
    removingSegment?.slot === "children",
  );
  const removingTabLabel = removingTab && removingSegment
    ? tabLabels(removingParent!)[removingSegment.index]
    : null;
  const configuring = configurePath ? nodeAtPath(config.root, configurePath) : null;
  return (
    <>
      {editorError ? <div className="global-error" role="alert"><strong>Edit failed</strong><span>{editorError}</span><button type="button" aria-label="Dismiss error" onClick={() => setEditorError(null)}>×</button></div> : null}
      <DashboardMetadataEditor config={config} onChange={onChange} />
      {diagnostics.length > 0 ? (
        <details className="editor-diagnostics" open={!valid}>
          <summary>Draft validation</summary>
          <ul>{diagnostics.map((item, index) => <li key={`${item.code}:${index}`}><code>{item.code}</code> {item.message}</li>)}</ul>
        </details>
      ) : null}
      <div className="editor-workbench" role="region" aria-label="Selected component actions">
        <div className="editor-workbench__selection">
          <span>Selected component</span>
          <strong>{selectedName}</strong>
          {selectedNode.id ? <code>{selectedNode.id}</code> : null}
        </div>
        <div className="editor-workbench__actions">
          <button className="button button--quiet editor-workbench__tree-toggle" type="button" disabled={collapsiblePaths.length === 0} onClick={() => {
            setCollapsed(allCollapsed
              ? new Set()
              : new Set(collapsiblePaths.map(pathKey)));
          }}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
          {selectedSegment && selectedCanReorder ? (
            <div className="editor-workbench__move" aria-label="Move selected component">
              <button className="editor-icon-button" type="button" aria-label={`Move ${selectedName} up`} title="Move up" disabled={selectedSegment.index === 0} onClick={() => {
                const nextPath = [...selectedParentPath, { ...selectedSegment, index: selectedSegment.index - 1 }];
                apply(() => moveNode(config, effectiveSelectedPath, { parentPath: selectedParentPath, slot: selectedSegment.slot, index: selectedSegment.index - 1 }, catalog), nextPath);
              }}><EditorIcon name="up" /></button>
              <button className="editor-icon-button" type="button" aria-label={`Move ${selectedName} down`} title="Move down" disabled={selectedSegment.index >= selectedSiblings.length - 1} onClick={() => {
                const nextPath = [...selectedParentPath, { ...selectedSegment, index: selectedSegment.index + 1 }];
                apply(() => moveNode(config, effectiveSelectedPath, { parentPath: selectedParentPath, slot: selectedSegment.slot, index: selectedSegment.index + 2 }, catalog), nextPath);
              }}><EditorIcon name="down" /></button>
            </div>
          ) : null}
          {effectiveSelectedPath.length === 0 ? (
            <button className="button button--quiet" type="button" onClick={() => setReplaceRootOpen(true)}>Replace root</button>
          ) : null}
          <button className="button button--secondary" type="button" disabled={!selectedManifest} onClick={() => setConfigurePath(effectiveSelectedPath)}><EditorIcon name="settings" />Configure</button>
          {effectiveSelectedPath.length > 0 ? (
            <button className="button button--quiet button--danger-quiet" type="button" onClick={() => setRemovePath(effectiveSelectedPath)}><EditorIcon name="remove" />Remove</button>
          ) : null}
        </div>
      </div>
      <section className="dashboard dashboard--editing" aria-label={`${config.name} dashboard editor`}>
        {renderNode(config.root, [], true)}
      </section>
      {addTarget ? <ComponentDialog catalog={catalog} config={config} target={addTarget} onApply={applyDraft} onDismiss={() => setAddTarget(null)} /> : null}
      {configurePath && configuring ? <ComponentDialog catalog={catalog} config={config} existing={{ path: configurePath, node: configuring }} onApply={applyDraft} onDismiss={() => setConfigurePath(null)} /> : null}
      {replaceRootOpen ? <ComponentDialog catalog={catalog} config={config} replaceRoot={config.root} onApply={(next) => {
        onChange(next);
        setSelectedPath([]);
      }} onDismiss={() => setReplaceRootOpen(false)} /> : null}
      {removePath && removing ? (
        <EditorModal title={removingTab ? "Remove tab?" : "Remove component?"} onDismiss={() => setRemovePath(null)}>
          <div className="remove-confirmation">
            {removingTab ? (
              <p>Remove the <strong>{removingTabLabel}</strong> tab?</p>
            ) : (
              <p>Remove <strong>{catalogManifest(catalog, removing.component)?.name ?? removing.component}</strong>?</p>
            )}
            {countNodes(removing) > 1 ? <p>This also removes {countNodes(removing) - 1} nested components.</p> : null}
            <p>The change remains recoverable until you save the dashboard.</p>
            <footer className="editor-modal__actions">
              <button className="button button--quiet" type="button" onClick={() => setRemovePath(null)}>Cancel</button>
              <button className="button button--danger" type="button" onClick={() => {
                apply(() => removeNode(config, removePath, catalog), removePath.slice(0, -1));
                setRemovePath(null);
              }}>{removingTab ? "Remove tab" : "Remove"}</button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
    </>
  );
}
