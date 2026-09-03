import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import "./env.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
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
} from "../../lib/env";

export default function EnvEditor({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const filesystem = componentHost.filesystem;
  const editorId = useId().replaceAll(":", "");
  const path = stringProp(props, ["path"]);
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
    if (!filesystem || !path) return;

    setLoading(true);
    setError(null);
    void filesystem
      .readText(path)
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
  }, [filesystem, path, refresh]);

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
      if (!filesystem?.writeText) throw new Error("This component does not have file-write access.");
      await filesystem.writeText(path, content);
      setSavedSource(content);
      if (mode === "table") setRawSource(content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!filesystem?.writeText) {
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
          <label className="visually-hidden" htmlFor={`${editorId}-env-raw`}>Raw environment file</label>
          <textarea
            id={`${editorId}-env-raw`}
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
              <button className="button button--primary" type="button" onClick={addEntry}>+ Add first variable</button>
            </div>
          )}
          {rows.length > 0 ? (
            <button className="button button--quiet env-editor__add" type="button" onClick={addEntry}>+ Add variable</button>
          ) : null}
        </div>
      )}
    </section>
  );
}
