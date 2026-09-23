import { useId } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { actionInvocation } from "../../../shared/action-invocation";
import "./button.css";

interface ButtonItem {
  name: string;
  action: unknown;
}

function itemsFromProps(props: Record<string, unknown>): ButtonItem[] {
  if (Array.isArray(props.items)) {
    return props.items.filter((item): item is ButtonItem =>
      Boolean(item && typeof item === "object" && typeof (item as ButtonItem).name === "string"),
    );
  }
  if (typeof props.name === "string") return [{ name: props.name, action: props.action }];
  return [];
}

function selectionContainer(reference: string): string | undefined {
  const match = /^select:([^/]+)\//.exec(reference);
  return match?.[1];
}

export default function ActionButton({ props, host }: ComponentRendererProps): ReactNode {
  const items = itemsFromProps(props);
  const requestedVariant = props.variant;
  const variant = requestedVariant === "segmented" || requestedVariant === "tabs" ? requestedVariant : "buttons";
  const resolved = items.map((item) => {
    const invocation = actionInvocation(item.action);
    const reference = invocation?.run ?? "";
    const action = host.actions.resolve(reference, item.name);
    return { item, invocation, reference, action };
  });
  const selectedContainers = resolved.map(({ reference }) => selectionContainer(reference));
  const tablist = variant === "tabs" && resolved.length > 0 && selectedContainers[0] !== undefined &&
    selectedContainers.every((container) => container === selectedContainers[0]);
  const id = useId().replaceAll(":", "");

  function selectWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (!tablist) return;
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % resolved.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + resolved.length) % resolved.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = resolved.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const item = resolved[next];
    if (!item) return;
    if (!item.action.active) host.actions.invoke(item.reference, item.invocation?.with, undefined, item.item.name);
    document.getElementById(`${id}-item-${next}`)?.focus();
  }

  if (resolved.length === 0) return <div className="component-state">This action bar has no actions.</div>;
  return (
    <div
      className={`action-button${resolved.length > 1 ? " action-button--group" : ""}${variant !== "buttons" ? ` action-button--${variant}` : ""}`}
      role={tablist ? "tablist" : undefined}
      aria-label={tablist && typeof props.label === "string" ? props.label : undefined}
    >
      {resolved.map(({ item, invocation, reference, action }, index) => {
        const disabledReason = action.running
          ? `${action.label} is already running.`
          : action.enabled
            ? undefined
            : action.disabledReason ?? "This action is unavailable.";
        const disabled = disabledReason !== undefined && !(tablist && action.active);
        const itemId = `${id}-item-${index}`;
        return (
          <div className="action-button__item" key={`${item.name}:${index}`}>
            <button
              id={itemId}
              className="action-button__control"
              type="button"
              disabled={disabled}
              role={tablist ? "tab" : undefined}
              aria-selected={tablist ? action.active : undefined}
              aria-current={!tablist && action.active ? "page" : undefined}
              aria-pressed={!tablist ? action.active : undefined}
              tabIndex={tablist ? (action.active || !resolved.some(({ action: candidate }) => candidate.active) && index === 0 ? 0 : -1) : undefined}
              aria-describedby={disabledReason && disabled ? `${itemId}-reason` : undefined}
              title={disabledReason}
              data-active={action.active || undefined}
              data-running={action.running || undefined}
              onClick={() => {
                if (!action.active || !tablist) {
                  host.actions.invoke(reference, invocation?.with, undefined, item.name);
                }
              }}
              onKeyDown={(event) => selectWithKeyboard(event, index)}
            >
              <span>{item.name}</span>
              {action.running ? <span className="action-button__spinner" aria-hidden="true" /> : null}
            </button>
            {disabledReason && disabled ? <span className="visually-hidden" id={`${itemId}-reason`} role="status">{disabledReason}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
