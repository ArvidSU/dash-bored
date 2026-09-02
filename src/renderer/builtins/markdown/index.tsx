import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import "./markdown.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { safeMarkdownUrl } from "../../safe-url";

type MarkdownView = "preview" | "raw";

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
  const [source, setSource] = useState(inlineContent);
  const [savedSource, setSavedSource] = useState(inlineContent);
  const [view, setView] = useState<MarkdownView>("preview");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

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
