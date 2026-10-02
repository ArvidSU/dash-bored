import type { ReactNode } from "react";
import "./status.css";
import type { ComponentRendererProps } from "../types";
import { stringProp } from "../shared";
import type { DashboardSource } from "../../lib/source";
import { useSourceComponent } from "../../lib/use-dashboard-source";
import { StateGlyph, stateTone } from "../../lib/state-visual";
import { parseStatusValue, type StatusSegment } from "../../lib/view-shapes";
import { SegmentMeter, Sparkline } from "../../lib/glance-visual";
import { useObservationChange } from "../../lib/observation-changes";

/** A short, escaped excerpt so invisible bytes such as ANSI color codes are visible. */
function receivedPreview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export default function Status({ props, host }: ComponentRendererProps): ReactNode {
  const label = stringProp(props, ["label", "name"], "Status");
  const source = props.source && typeof props.source === "object" && !Array.isArray(props.source)
    ? props.source as DashboardSource : null;
  const { state: sourceState, unavailable } = useSourceComponent(source, host, {
    label: "Refresh status",
    withoutSource: "This status uses a hand-written state.",
  });

  let value = stringProp(props, ["state", "status", "value"], "unknown");
  let detail = stringProp(props, ["detail", "description"]);
  let diagnostic: string | undefined;
  let trend: Array<number | null> | undefined;
  let segments: StatusSegment[] | undefined;
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
        trend = parsed.trend;
        segments = parsed.segments;
      } else {
        value = "unknown";
        detail = "";
        diagnostic = `Expected { state: unknown | healthy | warning | error, detail?: string, trend?: (number | null)[2..60], segments?: [{ label, value ≥ 0, state? }][1..8] } or a supervised process snapshot. Received ${receivedPreview(sourceState.value)}.`;
      }
    } else if (sourceState.loading) {
      value = "unknown";
      detail = "Loading status source…";
    }
  }

  const refreshing = sourceState.loading && sourceState.value !== undefined;
  const settled = source !== null && !unavailable && (sourceState.value !== undefined || sourceState.error !== undefined);
  const { change, flashing } = useObservationChange(value, settled);
  const compact = props.density === "compact";
  const tone = stateTone(value);
  const changedAt = change?.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={compact ? "status status--compact" : "status"} data-tone={tone} data-changed={flashing || undefined} aria-label={`${label}: ${value}`}>
      <span className={`status__dot status__dot--${tone}${refreshing ? " status__dot--refreshing" : ""}`} title={refreshing ? "Updating…" : undefined} aria-hidden="true"><StateGlyph tone={tone} /></span>
      <span className="status__label">{label}</span>
      {change ? <span className="status__changed" role="status" title={`Changed from ${change.from} at ${changedAt}`}>
        <span>Changed</span><span className="status__changed-from"> from {change.from} · {changedAt}</span>
      </span> : null}
      <span className="status__value">{value}</span>
      {trend ? <Sparkline values={trend} className="glance-sparkline status__trend" /> : null}
      {detail ? <span className="status__detail" title={compact ? detail : undefined}>{detail}</span> : null}
      {segments ? <div className="status__meter"><SegmentMeter segments={segments} label={`${label} breakdown`} /></div> : null}
      {diagnostic ? <span className="status__diagnostic" role="alert">Source shape: {diagnostic}</span> : null}
      {refreshing ? <span className="status__refreshing" role="status">Updating…</span> : null}
    </div>
  );
}
