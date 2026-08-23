import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ComponentCatalogItem,
  ComponentManifest,
  ComponentNode,
  DashboardConfig,
  Diagnostic,
  Permission,
  ResolvedComponentNode,
} from "../shared/contracts";
import { PERMISSION_LABELS } from "./action-providers";
import { BuiltinRenderer } from "./builtins";
import { host } from "./rpc-client";
import {
  catalogManifest,
  countNodes,
  countDiscardedRootNodes,
  createNode,
  insertNode,
  moveNode,
  nodeAtPath,
  pathKey,
  removeNode,
  replaceRoot as replaceRootNode,
  slotAcceptsMultiple,
  slotChildren,
  slotNames,
  tabLabels,
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
        <><circle cx="10" cy="10" r="3" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.5 1.5M13.5 13.5 15 15M15 5l-1.5 1.5M6.5 13.5 5 15" /></>
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

export function EditorModal({ title, children, onDismiss }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button, input, textarea, select")?.focus());
    const close = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
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
      previous?.focus();
    };
  }, [onDismiss]);
  return (
    <div className="editor-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onDismiss();
    }}>
      <div className="editor-modal__panel" role="dialog" aria-modal="true" aria-labelledby="editor-modal-title" ref={panelRef}>
        <header className="editor-modal__header">
          <h2 id="editor-modal-title">{title}</h2>
          <button className="editor-icon-button" type="button" aria-label="Close" onClick={onDismiss}>×</button>
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
      {visibleProperties.map(([name, schema]) => {
        const label = typeof schema.title === "string" ? schema.title : name;
        const description = typeof schema.description === "string" ? schema.description : null;
        if (!simpleProperty(schema)) return null;
        return (
          <label className="props-field" key={name}>
            <span>{label}{required.has(name) ? <em>Required</em> : null}</span>
            {Array.isArray(schema.enum) ? (
              <select value={value[name] === undefined ? "" : String(value[name])} onChange={(event) => changeProperty(name, schema, event.target.value)}>
                {value[name] === undefined && required.has(name) ? <option value="" disabled>Select…</option> : null}
                {!required.has(name) ? <option value="">Not set</option> : null}
                {schema.enum.map((option) => <option value={String(option)} key={String(option)}>{String(option)}</option>)}
              </select>
            ) : schema.type === "boolean" ? (
              <input type="checkbox" checked={value[name] === true} onChange={(event) => changeProperty(name, schema, event.target.checked)} />
            ) : (
              <input
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
      <EditorModal title={replaceRoot ? "Replace dashboard root" : existing ? "Configure component" : addingTab ? "Add tab" : "Add component"} onDismiss={onDismiss}>
      {!existing && !selected ? (
        <div className="component-picker">
          <input className="component-picker__search" type="search" placeholder="Search components…" aria-label="Search components" value={query} onChange={(event) => setQuery(event.target.value)} />
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

interface DashboardEditorProps {
  config: DashboardConfig;
  sourcePath?: string;
  catalog: readonly ComponentCatalogItem[];
  diagnostics: readonly Diagnostic[];
  requestedPermissions: readonly Permission[];
  saving: boolean;
  dirty: boolean;
  onChange: (config: DashboardConfig) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function DashboardEditor({
  config,
  sourcePath,
  catalog,
  diagnostics,
  requestedPermissions,
  saving,
  dirty,
  onChange,
  onSave,
  onCancel,
}: DashboardEditorProps): ReactNode {
  const [addTarget, setAddTarget] = useState<SlotTarget | null>(null);
  const [configurePath, setConfigurePath] = useState<NodePath | null>(null);
  const [replaceRootOpen, setReplaceRootOpen] = useState(false);
  const [removePath, setRemovePath] = useState<NodePath | null>(null);
  const [dragging, setDragging] = useState<NodePath | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const valid = diagnostics.every((item) => item.severity !== "error");

  const apply = (operation: () => DashboardConfig): void => {
    try {
      setEditorError(null);
      onChange(operation());
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    }
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
        apply(() => moveNode(config, JSON.parse(sourceText) as NodePath, target, catalog));
        setDragging(null);
      }}
    >
      <button type="button" aria-label={`Add component to ${target.slot}`} onClick={() => setAddTarget(target)}>
        <EditorIcon name="add" />
        {empty ? <span>Add component</span> : null}
      </button>
    </div>
  );

  const renderSlot = (parent: ComponentNode, parentPath: NodePath, slot: string): ReactNode => {
    const children = slotChildren(parent, slot);
    const multiple = slotAcceptsMultiple(catalog, parent, slot);
    return (
      <div className={`editor-slot${children.length === 0 ? " editor-slot--empty" : ""}`} data-slot={slot} key={slot}>
        <span className="editor-slot__label">{slot}</span>
        {multiple || children.length === 0
          ? renderDropZone({ parentPath, slot, index: 0 }, children.length === 0)
          : null}
        {children.map((child, index) => {
          const childPath = [...parentPath, { slot, index }];
          return (
            <div className="editor-slot__child" key={child.id ?? `${pathKey(childPath)}:${child.component}`}>
              {renderNode(child, childPath, false, multiple ? index : null, children.length)}
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
    siblingIndex: number | null,
    siblingCount: number,
  ): ReactNode => {
    const manifest = catalogManifest(catalog, node.component);
    const name = manifest?.name ?? node.component;
    const configuredSlots = slotNames(catalog, node);
    const resolvedNode: ResolvedComponentNode = {
      id: node.id ?? pathKey(path),
      component: node.component,
      props: node.props ?? {},
      slots: {},
      source: node.component.startsWith("./components/") ? "local" : "builtin",
      ...(node.component.startsWith("./components/") && manifest ? { manifest } : {}),
    };
    const parentPath = path.slice(0, -1);
    const segment = path.at(-1);
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
      preview = <div className="editor-component-preview"><strong>{name}</strong><code>{node.component}</code>{configuredSlots.map((slot) => renderSlot(node, path, slot))}</div>;
    }

    return (
      <section className={`editor-node${root ? " editor-node--root" : ""}`} data-editor-node={pathKey(path)}>
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
              }}
              onDragEnd={() => setDragging(null)}
            ><EditorIcon name="drag" /></button>
          ) : null}
          <span className="editor-node__identity"><strong>{name}</strong>{node.id ? <code>{node.id}</code> : null}</span>
          {root ? <button className="editor-node__replace" type="button" onClick={() => setReplaceRootOpen(true)}>Replace root</button> : null}
          {!root && siblingIndex !== null ? (
            <>
              <button className="editor-icon-button" type="button" aria-label={`Move ${name} up`} disabled={siblingIndex === 0} onClick={() => {
                if (!segment) return;
                apply(() => moveNode(config, path, { parentPath, slot: segment.slot, index: siblingIndex - 1 }, catalog));
              }}><EditorIcon name="up" /></button>
              <button className="editor-icon-button" type="button" aria-label={`Move ${name} down`} disabled={siblingIndex >= siblingCount - 1} onClick={() => {
                if (!segment) return;
                apply(() => moveNode(config, path, { parentPath, slot: segment.slot, index: siblingIndex + 2 }, catalog));
              }}><EditorIcon name="down" /></button>
            </>
          ) : null}
          <button className="editor-icon-button" type="button" aria-label={`Configure ${name}`} title="Configure" disabled={!manifest} onClick={() => setConfigurePath(path)}><EditorIcon name="settings" /></button>
          {!root ? <button className="editor-icon-button editor-icon-button--danger" type="button" aria-label={`Remove ${name}`} title="Remove" onClick={() => setRemovePath(path)}><EditorIcon name="remove" /></button> : null}
        </header>
        <div className="editor-node__preview">{preview}</div>
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
      <div className="editor-toolbar" role="region" aria-label="Dashboard editor">
        <div><span className="eyebrow">Edit mode</span><strong>{dirty ? "Unsaved dashboard changes" : "Dashboard is unchanged"}</strong>{sourcePath ? <code title={sourcePath}>{sourcePath}</code> : null}</div>
        <div className="editor-toolbar__status">
          {requestedPermissions.length ? <span title={requestedPermissions.map((permission) => PERMISSION_LABELS[permission]).join(", ")}>{requestedPermissions.length} capabilities</span> : <span>No capabilities</span>}
          {!valid ? <span className="badge badge--error">{diagnostics.filter((item) => item.severity === "error").length} errors</span> : <span className="badge">Valid</span>}
        </div>
        <div className="editor-toolbar__actions">
          <button className="button button--quiet" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button className="button button--primary" type="button" disabled={saving || !dirty || !valid} onClick={onSave}>{saving ? "Saving…" : "Save dashboard"}</button>
        </div>
      </div>
      {editorError ? <div className="global-error" role="alert"><strong>Edit failed</strong><span>{editorError}</span><button type="button" aria-label="Dismiss error" onClick={() => setEditorError(null)}>×</button></div> : null}
      {diagnostics.length > 0 ? (
        <details className="editor-diagnostics" open={!valid}>
          <summary>Draft validation</summary>
          <ul>{diagnostics.map((item, index) => <li key={`${item.code}:${index}`}><code>{item.code}</code> {item.message}</li>)}</ul>
        </details>
      ) : null}
      <section className="dashboard dashboard--editing" aria-label={`${config.name} dashboard editor`}>
        {renderNode(config.root, [], true, null, 1)}
      </section>
      {addTarget ? <ComponentDialog catalog={catalog} config={config} target={addTarget} onApply={onChange} onDismiss={() => setAddTarget(null)} /> : null}
      {configurePath && configuring ? <ComponentDialog catalog={catalog} config={config} existing={{ path: configurePath, node: configuring }} onApply={onChange} onDismiss={() => setConfigurePath(null)} /> : null}
      {replaceRootOpen ? <ComponentDialog catalog={catalog} config={config} replaceRoot={config.root} onApply={onChange} onDismiss={() => setReplaceRootOpen(false)} /> : null}
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
                apply(() => removeNode(config, removePath, catalog));
                setRemovePath(null);
              }}>{removingTab ? "Remove tab" : "Remove"}</button>
            </footer>
          </div>
        </EditorModal>
      ) : null}
    </>
  );
}
