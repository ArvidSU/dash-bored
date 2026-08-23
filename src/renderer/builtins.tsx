import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { WebviewTagElement } from "electrobun/view";
import type {
  ProcessSnapshot,
  ResolvedComponentNode,
} from "../shared/contracts";
import { host } from "./rpc-client";
import { safeMarkdownUrl } from "./safe-url";

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
          {panel}
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
  const label = stringProp(node.props, ["label", "title"], "Run command");
  const command = stringProp(node.props, ["command"]);
  const running = process?.phase === "running" || process?.phase === "stopping";

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
      <button
        className={running ? "button button--danger" : "button button--primary"}
        type="button"
        disabled={pending || process?.phase === "stopping"}
        onClick={() => void toggle()}
      >
        {pending ? "Working…" : running ? "Stop" : label}
      </button>
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

function Webview({ node, trusted }: BuiltinRendererProps): ReactNode {
  const url = stringProp(node.props, ["url", "src"]);
  const ref = useRef<WebviewTagElement>(null);
  const validUrl = useMemo(() => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, [url]);

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
      <electrobun-webview ref={ref} className="webview-shell__view" renderer="native" sandbox src={url} />
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
