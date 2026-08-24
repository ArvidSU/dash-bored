import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { WebviewTagElement } from "electrobun/view";
import type {
  ProcessSnapshot,
  ResolvedComponentNode,
} from "../shared/contracts";
import { host } from "./rpc-client";
import { safeMarkdownUrl } from "./safe-url";
import {
  appendEnvEntry,
  envEntries,
  invalidEnvLineCount,
  isValidEnvKey,
  parseEnv,
  removeEnvEntry,
  serializeEnv,
  updateEnvEntry,
  type EnvDocument,
} from "./env";

export type RenderedSlots = Record<string, ReactNode[]>;

export interface BuiltinRendererProps {
  node: ResolvedComponentNode;
  slots: RenderedSlots;
  trusted: boolean;
  processes: ReadonlyMap<string, ProcessSnapshot>;
}

function stringProp(
  props: Record<string, unknown>,
  names: string[],
  fallback = "",
): string {
  for (const name of names) {
    if (typeof props[name] === "string") return props[name];
  }
  return fallback;
}

function allChildren(slots: RenderedSlots): ReactNode[] {
  return Object.values(slots).flat();
}

const PanelVisibilityContext = createContext(true);

function CapabilityGate({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="component-state component-state--locked">
      <span className="component-state__icon" aria-hidden="true">
        ◇
      </span>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

function Tabs({ node, slots }: BuiltinRendererProps): ReactNode {
  const panels = slots.children ?? [];
  const parentVisible = useContext(PanelVisibilityContext);
  const rawLabels = node.props.labels;
  const labels = Array.isArray(rawLabels) ? rawLabels : [];
  const requestedDefault = node.props.defaultTab;
  const defaultIndex =
    typeof requestedDefault === "number" &&
    Number.isInteger(requestedDefault) &&
    requestedDefault >= 0 &&
    requestedDefault < panels.length
      ? requestedDefault
      : 0;
  const [active, setActive] = useState(defaultIndex);
  const id = useId().replaceAll(":", "");

  useEffect(() => {
    if (active >= panels.length) {
      setActive(defaultIndex);
    }
  }, [active, defaultIndex, panels.length]);

  function selectFromKeyboard(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % panels.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + panels.length) % panels.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = panels.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    setActive(nextIndex);
    document.getElementById(`${id}-tab-${nextIndex}`)?.focus();
  }

  if (panels.length === 0) {
    return <div className="component-state">This tab group has no tabs.</div>;
  }

  return (
    <section className="tabs">
      <div className="tabs__list" role="tablist" aria-label={stringProp(node.props, ["label"], "Dashboard sections")}>
        {panels.map((_, index) => {
          const selected = index === active;
          return (
            <button
              className="tabs__tab"
              id={`${id}-tab-${index}`}
              key={index}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(event) => selectFromKeyboard(event, index)}
            >
              {typeof labels[index] === "string" ? labels[index] : `Tab ${index + 1}`}
            </button>
          );
        })}
      </div>
      {panels.map((panel, index) => (
        <div
          className="tabs__panel"
          id={`${id}-panel-${index}`}
          key={index}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${index}`}
          hidden={index !== active}
        >
          <PanelVisibilityContext.Provider value={parentVisible && index === active}>
            {panel}
          </PanelVisibilityContext.Provider>
        </div>
      ))}
    </section>
  );
}

function Split({ node, slots }: BuiltinRendererProps): ReactNode {
  const direction = stringProp(node.props, ["direction"], "horizontal");
  const normalizedDirection = direction === "vertical" ? "vertical" : "horizontal";

  return (
    <div className={`split split--${normalizedDirection}`}>
      {Object.entries(slots).map(([name, children]) => (
        <div className="split__pane" data-slot={name} key={name}>
          {children}
        </div>
      ))}
    </div>
  );
}

function Stack({ node, slots }: BuiltinRendererProps): ReactNode {
  const requestedGap = stringProp(node.props, ["gap"], "medium");
  const gap = ["none", "small", "medium", "large"].includes(requestedGap)
    ? requestedGap
    : "medium";

  return <div className={`stack stack--${gap}`}>{allChildren(slots)}</div>;
}

function Card({ node, slots }: BuiltinRendererProps): ReactNode {
  const title = stringProp(node.props, ["title"]);
  const description = stringProp(node.props, ["description"]);

  return (
    <section className="card">
      {title || description ? (
        <header className="card__header">
          {title ? <h2>{title}</h2> : null}
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}
      <div className="card__body">{allChildren(slots)}</div>
    </section>
  );
}

function Text({ node }: BuiltinRendererProps): ReactNode {
  const content = stringProp(node.props, ["content", "text"]);
  const requestedVariant = stringProp(node.props, ["variant"], "body");
  const variant = ["title", "heading", "body", "muted", "code"].includes(
    requestedVariant,
  )
    ? requestedVariant
    : "body";

  if (variant === "title") return <h1 className="text text--title">{content}</h1>;
  if (variant === "heading") return <h2 className="text text--heading">{content}</h2>;
  if (variant === "code") return <code className="text text--code">{content}</code>;
  return <p className={`text text--${variant}`}>{content}</p>;
}

function Markdown({ node }: BuiltinRendererProps): ReactNode {
  const content = stringProp(node.props, ["content", "markdown"]);

  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="markdown__image-placeholder">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function Status({ node }: BuiltinRendererProps): ReactNode {
  const label = stringProp(node.props, ["label", "name"], "Status");
  const value = stringProp(node.props, ["state", "status", "value"], "unknown");
  const detail = stringProp(node.props, ["detail", "description"]);
  const normalized = value.toLowerCase();
  const tone = ["ok", "online", "healthy", "success", "ready"].includes(normalized)
    ? "positive"
    : ["warn", "warning", "pending", "starting"].includes(normalized)
      ? "warning"
      : ["error", "failed", "offline", "down"].includes(normalized)
        ? "negative"
        : "neutral";

  return (
    <div className="status">
      <span className={`status__dot status__dot--${tone}`} aria-hidden="true" />
      <span className="status__label">{label}</span>
      <span className="status__value">{value}</span>
      {detail ? <span className="status__detail">{detail}</span> : null}
    </div>
  );
}

function Command({ node, trusted, processes }: BuiltinRendererProps): ReactNode {
  const process = processes.get(node.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const label = stringProp(node.props, ["label", "title"], "Run command");
  const command = stringProp(node.props, ["command"]);
  const running = process?.phase === "running" || process?.phase === "stopping";
  const hasOutput = (process?.logs.length ?? 0) > 0;

  useEffect(() => {
    if (!showOutput) return;
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [process?.logs.length, showOutput]);

  if (!trusted) {
    return (
      <CapabilityGate title={label}>
        Trust this project to run its configured command.
      </CapabilityGate>
    );
  }

  async function toggle(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      if (running) await host.stopProcess(node.id);
      else await host.startProcess(node.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="command">
      <div className="command__content">
        <strong>{label}</strong>
        {command ? <code>{command}</code> : null}
        {process && process.phase !== "idle" ? (
          <span className={`phase phase--${process.phase}`}>{process.phase}</span>
        ) : null}
      </div>
      <div className="command__actions">
        <button
          className="button button--quiet button--small command__output-toggle"
          type="button"
          aria-expanded={showOutput}
          aria-controls={`${node.id}-output`}
          onClick={() => setShowOutput((value) => !value)}
        >
          {showOutput ? "Hide output" : "Show output"}
        </button>
        <button
          className={running ? "button button--danger" : "button button--primary"}
          type="button"
          disabled={pending || process?.phase === "stopping"}
          onClick={() => void toggle()}
        >
          {pending ? "Working…" : running ? "Stop" : label}
        </button>
      </div>
      {showOutput ? (
        <div
          id={`${node.id}-output`}
          className="command__output"
          ref={outputRef}
          tabIndex={0}
          role="log"
          aria-live="polite"
          aria-label={`Output for ${label}`}
        >
          {hasOutput ? (
            process!.logs.map((entry) => (
              <div className={`terminal__line terminal__line--${entry.stream}`} key={entry.sequence}>
                {entry.text}
              </div>
            ))
          ) : (
            <span className="terminal__empty">No output yet.</span>
          )}
        </div>
      ) : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
  );
}

function Terminal({ node, trusted, processes }: BuiltinRendererProps): ReactNode {
  const requestedProcessId = stringProp(node.props, ["processId", "commandId"]);
  const processId = requestedProcessId || node.id;
  const process = processes.get(processId);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [process?.logs.length]);

  if (!trusted) {
    return (
      <CapabilityGate title="Process output">
        Trust this project to view command output.
      </CapabilityGate>
    );
  }

  return (
    <section className="terminal" aria-label={`Output for ${processId}`}>
      <header className="terminal__header">
        <span className="terminal__lights" aria-hidden="true"><i /><i /><i /></span>
        <code>{processId}</code>
        <span className={`phase phase--${process?.phase ?? "idle"}`}>
          {process?.phase ?? "idle"}
        </span>
      </header>
      <div className="terminal__output" ref={outputRef} tabIndex={0}>
        {process?.logs.length ? (
          process.logs.map((entry) => (
            <div className={`terminal__line terminal__line--${entry.stream}`} key={entry.sequence}>
              {entry.text}
            </div>
          ))
        ) : (
          <span className="terminal__empty">No output yet.</span>
        )}
      </div>
    </section>
  );
}

function FileViewer({ node, trusted }: BuiltinRendererProps): ReactNode {
  const path = stringProp(node.props, ["path"]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!trusted || !path) return;

    setLoading(true);
    setError(null);
    void host
      .readTextFile({ nodeId: node.id, path })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [node.id, path, refresh, trusted]);

  if (!trusted) {
    return (
      <CapabilityGate title={path || "File viewer"}>
        Trust this project to read workspace files.
      </CapabilityGate>
    );
  }

  return (
    <section className="file-viewer">
      <header className="file-viewer__header">
        <code>{path || "No file configured"}</code>
        <button className="button button--quiet" type="button" disabled={!path || loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </header>
      {error ? <div className="component-state component-state--error" role="alert">{error}</div> : null}
      {!error ? <pre className="file-viewer__content"><code>{content}</code></pre> : null}
    </section>
  );
}

function EnvEditor({ node, trusted }: BuiltinRendererProps): ReactNode {
  const path = stringProp(node.props, ["path"]);
  const [document, setDocument] = useState<EnvDocument>(() => parseEnv(""));
  const [rawSource, setRawSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [mode, setMode] = useState<"table" | "raw">("table");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!trusted || !path) return;

    setLoading(true);
    setError(null);
    void host
      .readTextFile({ nodeId: node.id, path })
      .then((source) => {
        if (cancelled) return;
        setDocument(parseEnv(source));
        setRawSource(source);
        setSavedSource(source);
        setMode("table");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [node.id, path, refresh, trusted]);

  const tableSource = serializeEnv(document);
  const content = mode === "raw" ? rawSource : tableSource;
  const dirty = content !== savedSource;
  const rows = envEntries(document);
  const invalidKeys = rows.filter(({ entry }) => !isValidEnvKey(entry.key)).length;
  const invalidLines = invalidEnvLineCount(document);

  function switchMode(nextMode: "table" | "raw"): void {
    if (nextMode === mode) return;
    if (nextMode === "raw") {
      setRawSource(tableSource);
    } else {
      setDocument(parseEnv(rawSource));
    }
    setMode(nextMode);
    setError(null);
  }

  function updateEntry(
    lineIndex: number,
    field: "key" | "value",
    value: string,
  ): void {
    const nextDocument = updateEnvEntry(document, lineIndex, { [field]: value });
    setDocument(nextDocument);
    setRawSource(serializeEnv(nextDocument));
    setError(null);
  }

  function addEntry(): void {
    const nextDocument = appendEnvEntry(document);
    setDocument(nextDocument);
    setRawSource(serializeEnv(nextDocument));
    setError(null);
  }

  function deleteEntry(lineIndex: number): void {
    const nextDocument = removeEnvEntry(document, lineIndex);
    setDocument(nextDocument);
    setRawSource(serializeEnv(nextDocument));
    setError(null);
  }

  async function save(): Promise<void> {
    if (!path || !dirty || invalidKeys > 0) return;
    setSaving(true);
    setError(null);
    try {
      await host.writeTextFile({ nodeId: node.id, path, content });
      setSavedSource(content);
      if (mode === "table") setRawSource(content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!trusted) {
    return (
      <CapabilityGate title="Environment editor">
        Trust this project to read and write the configured environment file.
      </CapabilityGate>
    );
  }

  if (!path) {
    return (
      <div className="component-state component-state--error" role="alert">
        Configure a relative environment file path first.
      </div>
    );
  }

  return (
    <section className="env-editor" aria-label={`Environment editor for ${path}`}>
      <header className="env-editor__header">
        <div className="env-editor__title">
          <span className="env-editor__glyph" aria-hidden="true">{`{ }`}</span>
          <div>
            <strong>Environment variables</strong>
            <code title={path}>{path}</code>
          </div>
        </div>
        <div className="env-editor__actions">
          <div className="env-editor__mode" role="group" aria-label="Editor mode">
            <button
              className={mode === "table" ? "env-editor__mode-button env-editor__mode-button--active" : "env-editor__mode-button"}
              type="button"
              aria-pressed={mode === "table"}
              onClick={() => switchMode("table")}
            >
              Key-value
            </button>
            <button
              className={mode === "raw" ? "env-editor__mode-button env-editor__mode-button--active" : "env-editor__mode-button"}
              type="button"
              aria-pressed={mode === "raw"}
              onClick={() => switchMode("raw")}
            >
              Bulk / raw
            </button>
          </div>
          <button className="button button--quiet" type="button" disabled={loading || saving} onClick={() => setRefresh((value) => value + 1)}>
            {loading ? "Reading…" : "Reload"}
          </button>
          <button className="button button--primary" type="button" disabled={loading || saving || !dirty || invalidKeys > 0} onClick={() => void save()}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </header>
      {error ? <div className="component-state component-state--error" role="alert">{error}</div> : null}
      {mode === "raw" ? (
        <div className="env-editor__raw-wrap">
          <label className="visually-hidden" htmlFor={`${node.id}-env-raw`}>Raw environment file</label>
          <textarea
            id={`${node.id}-env-raw`}
            className="env-editor__raw"
            value={rawSource}
            onChange={(event) => {
              setRawSource(event.target.value);
              setError(null);
            }}
            spellCheck={false}
          />
          <p className="env-editor__hint">Paste or edit the complete file, then save when ready.</p>
        </div>
      ) : (
        <div className="env-editor__table-wrap">
          {invalidLines > 0 ? (
            <p className="env-editor__notice">
              {invalidLines} unrecognized {invalidLines === 1 ? "line is" : "lines are"} preserved below in the raw file.
            </p>
          ) : null}
          {invalidKeys > 0 ? (
            <p className="env-editor__error" role="alert">Use letters, numbers, and underscores for variable names; names must not start with a number.</p>
          ) : null}
          {rows.length > 0 ? (
            <table className="env-editor__table">
              <thead>
                <tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map(({ lineIndex, entry }) => {
                  const validKey = isValidEnvKey(entry.key);
                  return (
                    <tr key={lineIndex}>
                      <td>
                        <input
                          className={validKey ? "env-editor__input env-editor__key" : "env-editor__input env-editor__key env-editor__input--invalid"}
                          aria-label={`Variable name ${lineIndex + 1}`}
                          aria-invalid={!validKey}
                          value={entry.key}
                          onChange={(event) => updateEntry(lineIndex, "key", event.target.value)}
                          spellCheck={false}
                        />
                      </td>
                      <td>
                        <input
                          className="env-editor__input"
                          aria-label={`Variable value for ${entry.key || "unnamed variable"}`}
                          value={entry.value}
                          onChange={(event) => updateEntry(lineIndex, "value", event.target.value)}
                          spellCheck={false}
                        />
                      </td>
                      <td>
                        <button className="env-editor__delete" type="button" onClick={() => deleteEntry(lineIndex)} aria-label={`Remove ${entry.key || "unnamed variable"}`}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="env-editor__empty">
              <strong>No variables yet</strong>
              <span>Add the first key-value pair or switch to raw mode to paste a complete file.</span>
            </div>
          )}
          <button className="button button--quiet env-editor__add" type="button" onClick={addEntry}>+ Add variable</button>
        </div>
      )}
    </section>
  );
}

function Webview({ node, trusted }: BuiltinRendererProps): ReactNode {
  const url = stringProp(node.props, ["url", "src"]);
  const panelVisible = useContext(PanelVisibilityContext);
  const ref = useRef<WebviewTagElement>(null);
  const [nativeViewMounted, setNativeViewMounted] = useState(panelVisible && trusted);
  const validUrl = useMemo(() => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, [url]);

  useLayoutEffect(() => {
    if (!trusted) {
      setNativeViewMounted(false);
    } else if (panelVisible) {
      // Do not initialize a native child webview while its tab is hidden. Its
      // first DOM rect would be 0x0, and the native overlay has no DOM parent
      // that can hide it later.
      setNativeViewMounted(true);
    }
  }, [panelVisible, trusted]);

  useLayoutEffect(() => {
    const view = ref.current;
    if (!view) return;
    view.toggleHidden(!panelVisible);
    if (panelVisible) view.syncDimensions(true);
  }, [nativeViewMounted, panelVisible]);

  if (!trusted) {
    return (
      <CapabilityGate title="Embedded page">
        Trust this project to load its configured web page.
      </CapabilityGate>
    );
  }

  if (!validUrl) {
    return (
      <div className="component-state component-state--error" role="alert">
        The webview requires an absolute HTTP or HTTPS URL.
      </div>
    );
  }

  return (
    <section className="webview-shell">
      <header className="webview-shell__header">
        <span className="webview-shell__url" title={url}>{url}</span>
        <button className="button button--quiet" type="button" onClick={() => ref.current?.reload()}>
          Reload
        </button>
      </header>
      {nativeViewMounted ? (
        <electrobun-webview ref={ref} className="webview-shell__view" renderer="native" sandbox src={url} />
      ) : null}
    </section>
  );
}

export function BuiltinRenderer(props: BuiltinRendererProps): ReactNode {
  switch (props.node.component) {
    case "@dash-bored/tabs":
      return <Tabs {...props} />;
    case "@dash-bored/split":
      return <Split {...props} />;
    case "@dash-bored/stack":
      return <Stack {...props} />;
    case "@dash-bored/card":
      return <Card {...props} />;
    case "@dash-bored/text":
      return <Text {...props} />;
    case "@dash-bored/markdown":
      return <Markdown {...props} />;
    case "@dash-bored/status":
      return <Status {...props} />;
    case "@dash-bored/command":
      return <Command {...props} />;
    case "@dash-bored/terminal":
      return <Terminal {...props} />;
    case "@dash-bored/file":
      return <FileViewer {...props} />;
    case "@dash-bored/env":
      return <EnvEditor {...props} />;
    case "@dash-bored/webview":
      return <Webview {...props} />;
    default:
      return (
        <div className="component-state component-state--error" role="alert">
          Unknown built-in component <code>{props.node.component}</code>.
        </div>
      );
  }
}
