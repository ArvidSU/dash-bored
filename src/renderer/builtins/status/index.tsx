import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { stringProp } from "../shared";

export default function Status({ props }: ComponentRendererProps): ReactNode {
  const label = stringProp(props, ["label", "name"], "Status");
  const value = stringProp(props, ["state", "status", "value"], "unknown");
  const detail = stringProp(props, ["detail", "description"]);
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
