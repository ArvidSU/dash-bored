import { useCallback, useEffect, useId, useState } from "react";
import { useContext } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import "./markdown.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { safeMarkdownUrl } from "../../lib/safe-url";
import { ComponentVisibilityContext } from "../../composition/ComponentCompositor";
import type { DashboardSource } from "../../lib/source";
import { useSourceComponent, type DashboardSourceState } from "../../lib/use-dashboard-source";

type MarkdownView = "preview" | "raw";

function MarkdownSourceView({ props, state, unavailable, onRefresh }: {
  props: Record<string, unknown>;
  state: DashboardSourceState;
  unavailable: string | undefined;
  onRefresh: () => void;
}): ReactNode {
  const visible = useContext(ComponentVisibilityContext);
  const title = stringProp(props, ["title"], "Markdown source");
  if (unavailable) return <CapabilityGate title={title}>Trust this project and grant {unavailable} to read this source.</CapabilityGate>;
  const text = typeof state.value === "string" ? state.value : state.value === undefined ? "" : `\`\`\`json\n${JSON.stringify(state.value, null, 2)}\n\`\`\``;
  return <section className="markdown-viewer" data-refreshing={state.loading && state.value !== undefined || undefined} aria-label={title}>
    <header className="markdown-viewer__header"><strong>{title}</strong><button className="button button--quiet" type="button" onClick={onRefresh} disabled={state.loading}>Refresh</button></header>
    {state.loading && state.value === undefined ? <div className="component-state" role="status">Loading…</div> : null}
    {state.loading && state.value !== undefined ? <small className="visually-hidden" role="status">Updating…</small> : null}
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
  const { state: sourceState, unavailable, refresh, refreshes } = useSourceComponent(sourceSpec ?? null, componentHost, {
    label: "Refresh Markdown",
    withoutSource: path ? filesystem ? null : "Trust this project to read the Markdown file." : "Inline Markdown has no source to refresh.",
    unavailableReason: () => "Trust this project to read the configured source.",
    confirmation: source !== savedSource ? { title: "Discard Markdown edits and reload?" } : undefined,
  });

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
  }, [filesystem, inlineContent, path, refreshes]);

  const dirty = source !== savedSource;

  const save = useCallback(async (reportFailure = false): Promise<void> => {
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
      if (reportFailure) throw cause;
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, path, filesystem, source, componentHost.dashboard, props]);

  const cancelEdit = useCallback((): void => {
    setSource(savedSource);
    setError(null);
    setView("preview");
  }, [savedSource]);

  useEffect(() => {
    const editable = !sourceSpec && (!path || Boolean(filesystem?.writeText));
    const available = editable && !loading && !saving;
    const reason = sourceSpec ? "Source Markdown is read-only." : !editable ? "Trust this project to edit this file." : "Markdown editor is busy.";
    const unregister = [
      componentHost.actions.register({ id: "edit", label: "Edit Markdown", enabled: available && view !== "raw", disabledReason: !available ? reason : "Editor is already open.", run: () => setView("raw") }),
      componentHost.actions.register({ id: "preview", label: "Preview Markdown", enabled: !sourceSpec && view !== "preview" && !saving, disabledReason: sourceSpec ? reason : "Preview is already open or the editor is busy.", run: () => setView("preview") }),
      componentHost.actions.register({ id: "save", label: "Save Markdown edits", enabled: available && dirty, disabledReason: !available ? reason : "No unsaved Markdown edits.", confirmation: path ? { title: "Save Markdown file?", message: `Write edits to ${path}.` } : undefined, run: () => save(true) }),
      componentHost.actions.register({ id: "cancel", label: "Discard Markdown edits", enabled: available && dirty, disabledReason: !available ? reason : "No unsaved Markdown edits.", confirmation: { title: "Discard Markdown edits?" }, run: cancelEdit }),
    ];
    return () => unregister.forEach((remove) => remove());
  }, [componentHost.actions, componentHost.dashboard, filesystem, sourceSpec, path, loading, saving, dirty, view, source, savedSource, props, save, cancelEdit]);

  if (sourceSpec !== undefined) return <MarkdownSourceView props={props} state={sourceState} unavailable={unavailable} onRefresh={refresh} />;

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
              onClick={refresh}
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
