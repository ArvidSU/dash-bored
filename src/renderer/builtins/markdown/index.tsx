import { useEffect, useId, useState } from "react";
import { useContext } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import "./markdown.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { safeMarkdownUrl } from "../../lib/safe-url";
import { ComponentVisibilityContext } from "../../composition/ComponentCompositor";
import { readDashboardSource, type DashboardSource } from "../../lib/source";

type MarkdownView = "preview" | "raw";

function MarkdownSourceView({ props, source, host, refresh, onRefresh }: {
  props: Record<string, unknown>;
  source: DashboardSource;
  host: ComponentRendererProps["host"];
  refresh: number;
  onRefresh: () => void;
}): ReactNode {
  const visible = useContext(ComponentVisibilityContext);
  const every = typeof source.every === "number" ? Math.max(1000, Math.min(300000, source.every)) : undefined;
  const title = stringProp(props, ["title"], "Markdown source");
  const [state, setState] = useState<{ value?: unknown; error?: string; loading: boolean }>({ loading: true });
  const processSnapshot = source.process ? host.processes?.get(source.process) : undefined;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      setState((old) => ({ ...old, loading: true, error: undefined }));
      try {
        const value = await readDashboardSource(source, host);
        if (!cancelled) setState({ value, loading: false });
      } catch (cause) {
        if (!cancelled) setState((old) => ({ ...old, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        if (!cancelled && every !== undefined) timer = window.setTimeout(() => void load(), every);
      }
    };
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [every, host, refresh, source, visible]);
  useEffect(() => {
    if (source.process && processSnapshot !== undefined) setState({ value: processSnapshot, loading: false });
  }, [processSnapshot, source.process]);
  const permission = source.shell ? "process:execute" : source.http ? "network:http" : source.process ? "process:observe" : source.file ? "filesystem:read" : undefined;
  const missing = permission === "process:execute" && !host.shell || permission === "network:http" && !host.http || permission === "process:observe" && !host.processes || permission === "filesystem:read" && !host.filesystem;
  if (missing) return <CapabilityGate title={title}>Trust this project and grant {permission} to read this source.</CapabilityGate>;
  const text = typeof state.value === "string" ? state.value : state.value === undefined ? "" : `\`\`\`json\n${JSON.stringify(state.value, null, 2)}\n\`\`\``;
  return <section className="markdown-viewer" aria-label={title}>
    <header className="markdown-viewer__header"><strong>{title}</strong><button className="button button--quiet" type="button" onClick={onRefresh} disabled={state.loading}>Refresh</button></header>
    {state.loading && state.value === undefined ? <div className="component-state" role="status">Loading…</div> : null}
    {state.loading && state.value !== undefined ? <small role="status">Updating…</small> : null}
    {state.error ? <div className="component-state component-state--error" role="alert">{state.value === undefined ? "Source error" : "Stale value"}: {state.error}</div> : null}
    {state.value !== undefined ? <MarkdownPreview content={text} /> : null}
    {!visible ? <small>Paused while hidden</small> : null}
  </section>;
}

function MarkdownPreview({ content }: { content: string }): ReactNode {
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

export default function Markdown({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const filesystem = componentHost.filesystem;
  const editorId = useId().replaceAll(":", "");
  const path = stringProp(props, ["path"]).trim();
  const inlineContent = stringProp(props, ["content", "markdown"]);
  const sourceSpec = props.source && typeof props.source === "object" ? props.source as DashboardSource : undefined;
  const [source, setSource] = useState(inlineContent);
  const [savedSource, setSavedSource] = useState(inlineContent);
  const [view, setView] = useState<MarkdownView>("preview");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const sourcePermissionAvailable = !sourceSpec
    || (sourceSpec.shell ? Boolean(componentHost.shell)
      : sourceSpec.http ? Boolean(componentHost.http)
        : sourceSpec.process ? Boolean(componentHost.processes)
          : sourceSpec.file ? Boolean(filesystem)
            : true);

  useEffect(() => componentHost.actions.register({
    id: "refresh",
    label: "Refresh Markdown",
    enabled: sourceSpec ? sourcePermissionAvailable : Boolean(path && filesystem),
    disabledReason: sourceSpec
      ? sourcePermissionAvailable ? undefined : "Trust this project to read the configured source."
      : path ? filesystem ? undefined : "Trust this project to read the Markdown file."
        : "Inline Markdown has no source to refresh.",
    run: () => setRefresh((current) => current + 1),
  }), [componentHost.actions, filesystem, path, sourcePermissionAvailable, sourceSpec]);

  useEffect(() => {
    let cancelled = false;
    setView("preview");
    setError(null);

    if (!path) {
      setSource(inlineContent);
      setSavedSource(inlineContent);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (!filesystem) {
      setSource("");
      setSavedSource("");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setSource("");
    setSavedSource("");
    setLoading(true);
    void filesystem
      .readText(path)
      .then((content) => {
        if (cancelled) return;
        setSource(content);
        setSavedSource(content);
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
  }, [filesystem, inlineContent, path, refresh]);

  const dirty = source !== savedSource;

  if (sourceSpec !== undefined) return <MarkdownSourceView host={componentHost} props={props} source={sourceSpec} refresh={refresh} onRefresh={() => setRefresh((current) => current + 1)} />;

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (path) {
        if (!filesystem?.writeText) throw new Error("This component does not have file-write access.");
        await filesystem.writeText(path, source);
      } else {
        await componentHost.dashboard.updateProps({ ...props, content: source });
      }
      setSavedSource(source);
      setView("preview");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit(): void {
    setSource(savedSource);
    setError(null);
    setView("preview");
  }

  const title = path ? "Markdown file" : "Markdown";
  const label = path ? `Markdown preview for ${path}` : "Markdown preview";

  if (path && !filesystem) {
    return (
      <CapabilityGate title={title}>
        Trust this project to read and edit workspace Markdown files.
      </CapabilityGate>
    );
  }

  return (
    <section className="markdown-viewer" aria-label={label}>
      <header className="markdown-viewer__header">
        <div className="markdown-viewer__title">
          <strong>{title}</strong>
          {path ? <code title={path}>{path}</code> : null}
        </div>
        <div className="markdown-viewer__actions">
          <div className="markdown-viewer__mode" role="group" aria-label="Markdown view">
            <button
              className={view === "preview" ? "markdown-viewer__mode-button markdown-viewer__mode-button--active" : "markdown-viewer__mode-button"}
              type="button"
              aria-pressed={view === "preview"}
              onClick={() => setView("preview")}
            >
              Preview
            </button>
            <button
              className={view === "raw" ? "markdown-viewer__mode-button markdown-viewer__mode-button--active" : "markdown-viewer__mode-button"}
              type="button"
              aria-pressed={view === "raw"}
              onClick={() => setView("raw")}
            >
              Raw / edit
            </button>
          </div>
          {path ? (
            <button
              className="button button--quiet"
              type="button"
              disabled={loading || saving || dirty}
              onClick={() => setRefresh((value) => value + 1)}
            >
              {loading ? "Reading…" : "Reload"}
            </button>
          ) : null}
          {dirty ? (
            <>
              <button className="button button--quiet" type="button" disabled={saving} onClick={cancelEdit}>
                Cancel
              </button>
              <button className="button button--primary" type="button" disabled={loading || saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          ) : null}
        </div>
      </header>
      {error ? <div className="component-state component-state--error" role="alert">{error}</div> : null}
      {loading ? <div className="component-state">Reading {path}…</div> : null}
      {!loading && !error && view === "preview" ? <MarkdownPreview content={source} /> : null}
      {!loading && !error && view === "raw" ? (
        <div className="markdown-viewer__raw-wrap">
          <label className="visually-hidden" htmlFor={`${editorId}-markdown-raw`}>Raw Markdown</label>
          <textarea
            id={`${editorId}-markdown-raw`}
            className="markdown-viewer__raw"
            value={source}
            spellCheck={false}
            onChange={(event) => {
              setSource(event.target.value);
              setError(null);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
