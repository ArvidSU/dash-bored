import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import "./file.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";

export default function FileViewer({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const filesystem = componentHost.filesystem;
  const path = stringProp(props, ["path"]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!filesystem || !path) return;

    setLoading(true);
    setError(null);
    void filesystem
      .readText(path)
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
  }, [filesystem, path, refresh]);

  if (!filesystem) {
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
