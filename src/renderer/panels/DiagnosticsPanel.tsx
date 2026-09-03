import type { ReactNode } from "react";
import type { Diagnostic } from "../../shared/contracts";

function DiagnosticItem({ diagnostic }: { diagnostic: Diagnostic }): ReactNode {
  const location = [
    diagnostic.file,
    diagnostic.line ? `line ${diagnostic.line}` : null,
    diagnostic.column ? `column ${diagnostic.column}` : null,
    diagnostic.path,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={`diagnostic diagnostic--${diagnostic.severity}`}>
      <span className="diagnostic__marker" aria-hidden="true" />
      <div>
        <div className="diagnostic__heading">
          <code>{diagnostic.code}</code>
          <strong>{diagnostic.message}</strong>
        </div>
        {location ? <span className="diagnostic__location">{location}</span> : null}
      </div>
    </li>
  );
}

export function Diagnostics({
  diagnostics,
  pending,
  onFixWithAgent,
}: {
  diagnostics: Diagnostic[];
  pending: boolean;
  onFixWithAgent: () => void;
}): ReactNode {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const summary = [
    errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : null,
    warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <details className="diagnostics" open={errors > 0}>
      <summary>
        <span>Configuration diagnostics</span>
        <span className="diagnostics__header-actions">
          <span className={errors ? "badge badge--error" : "badge badge--warning"}>{summary}</span>
          <button
            className="button button--quiet button--small diagnostics__fix"
            type="button"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onFixWithAgent();
            }}
          >
            {pending ? "Starting…" : "Fix with agent"}
          </button>
        </span>
      </summary>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <DiagnosticItem diagnostic={diagnostic} key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`} />
        ))}
      </ul>
    </details>
  );
}
