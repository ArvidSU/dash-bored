import { useId, type ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { actionInvocation } from "../../../shared/action-invocation";
import "./button.css";

export default function ActionButton({ props, host }: ComponentRendererProps): ReactNode {
  const name = typeof props.name === "string" ? props.name : "Action";
  const invocation = actionInvocation(props.action);
  const reference = invocation?.run ?? "";
  const action = host.actions.resolve(reference);
  const reasonId = useId();
  const disabledReason = action.running
    ? `${action.label} is already running.`
    : action.enabled
      ? undefined
      : action.disabledReason ?? "This action is unavailable.";
  const disabled = disabledReason !== undefined;

  return (
    <div className="action-button">
      <button
        className="action-button__control"
        type="button"
        disabled={disabled}
        aria-current={action.active ? "page" : undefined}
        aria-pressed={action.active}
        aria-describedby={disabledReason ? reasonId : undefined}
        title={disabledReason}
        data-active={action.active || undefined}
        data-running={action.running || undefined}
        onClick={() => host.actions.invoke(reference, invocation?.with)}
      >
        <span>{name}</span>
        {action.running ? <span className="action-button__spinner" aria-hidden="true" /> : null}
      </button>
      {disabledReason ? <span className="visually-hidden" id={reasonId} role="status">{disabledReason}</span> : null}
    </div>
  );
}
