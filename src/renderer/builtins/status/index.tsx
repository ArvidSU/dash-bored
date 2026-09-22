import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import "./status.css";
import type { ComponentRendererProps } from "../types";
import { stringProp } from "../shared";
import type { DashboardSource } from "../../lib/source";
import { useDashboardSource } from "../../lib/use-dashboard-source";
import { parseStatusValue } from "../../lib/view-shapes";

function sourceUnavailable(source: DashboardSource | null, host: ComponentRendererProps["host"]): string | undefined {
  if (!source) return undefined;
  if (source.shell && !host.shell) return "process:execute";
  if (source.file && !host.filesystem) return "filesystem:read";
  if (source.http && !host.http) return "network:http";
  if (source.process && !host.processes) return "process:observe";
  return undefined;
}

export default function Status({ props, host }: ComponentRendererProps): ReactNode {
  const label = stringProp(props, ["label", "name"], "Status");
  const source = props.source && typeof props.source === "object" && !Array.isArray(props.source)
    ? props.source as DashboardSource : null;
  const [refresh, setRefresh] = useState(0);
  const unavailable = sourceUnavailable(source, host);
  const sourceState = useDashboardSource(unavailable ? null : source, host, refresh);

  useEffect(() => host.actions.register({
    id: "refresh",
    label: "Refresh status",
    enabled: source !== null && unavailable === undefined,
    disabledReason: !source ? "This status uses a hand-written state." : unavailable ? `Trust this project to grant ${unavailable}.` : undefined,
    run: () => setRefresh((value) => value + 1),
  }), [host.actions, source !== null, unavailable]);

  let value = stringProp(props, ["state", "status", "value"], "unknown");
  let detail = stringProp(props, ["detail", "description"]);
  let diagnostic: string | undefined;
  if (source) {
    if (unavailable) {
      value = "unknown";
      detail = `Trust this project to read the source (${unavailable}).`;
    } else if (sourceState.error) {
      value = "error";
      detail = sourceState.error;
    } else if (sourceState.value !== undefined) {
      const parsed = parseStatusValue(sourceState.value);
      if (parsed) {
        value = parsed.state;
        detail = parsed.detail ?? "";
      } else {
        value = "unknown";
        detail = "";
        diagnostic = "Expected { state: unknown | healthy | warning | error, detail?: string } or a supervised process snapshot.";
      }
    } else if (sourceState.loading) {
      value = "unknown";
      detail = "Loading status source…";
    }
  }

  const normalized = value.toLowerCase();
  const tone = ["ok", "online", "healthy", "success", "ready"].includes(normalized)
    ? "positive"
    : ["warn", "warning", "pending", "starting"].includes(normalized)
      ? "warning"
      : ["error", "failed", "offline", "down"].includes(normalized)
        ? "negative"
        : "neutral";
  return (
    <div className="status" aria-label={`${label}: ${value}`}>
      <span className={`status__dot status__dot--${tone}`} aria-hidden="true" />
      <span className="status__label">{label}</span>
      <span className="status__value">{value}</span>
      {detail ? <span className="status__detail">{detail}</span> : null}
      {diagnostic ? <span className="status__diagnostic" role="alert">Source shape: {diagnostic}</span> : null}
      {sourceState.loading && sourceState.value !== undefined ? <span className="status__refreshing" role="status">Updating…</span> : null}
    </div>
  );
}
