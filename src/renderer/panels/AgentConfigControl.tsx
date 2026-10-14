import type { ReactNode } from "react";
import type { AgentConfigOption } from "../../shared/agent-session";

/** Consecutive options that share a group render as one <optgroup>, in agent order. */
function optionSegments(options: NonNullable<AgentConfigOption["options"]>) {
  const segments: Array<{ group?: string; options: typeof options }> = [];
  for (const option of options) {
    const last = segments.at(-1);
    if (last && last.group === option.group) last.options.push(option);
    else segments.push({ ...(option.group ? { group: option.group } : {}), options: [option] });
  }
  return segments;
}

function choiceOptions(option: AgentConfigOption): ReactNode {
  return optionSegments(option.options ?? []).map((segment, index) => {
    // Agents may repeat a value across groups; the key stays unique anyway.
    const items = segment.options.map((choice, choiceIndex) => (
      <option key={`${segment.group ?? ""}:${choiceIndex}:${choice.value}`} value={choice.value} title={choice.description}>{choice.name}</option>
    ));
    return segment.group ? <optgroup key={`${segment.group}-${index}`} label={segment.group}>{items}</optgroup> : items;
  });
}

/** Whether `value` is one of the option's current choices. */
export function agentConfigOffers(option: AgentConfigOption, value: string | boolean): boolean {
  return option.type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string" && (option.options ?? []).some((choice) => choice.value === value);
}

/** One option of a running session; a change is sent to the agent at once. */
export function AgentConfigControl({
  option,
  disabled,
  onChange,
}: {
  option: AgentConfigOption;
  disabled: boolean;
  onChange(value: string | boolean): void;
}): ReactNode {
  if (option.type === "boolean") {
    return (
      <label className="agent-config agent-config--boolean" title={option.description}>
        <input type="checkbox" checked={option.currentValue === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span>{option.name}</span>
      </label>
    );
  }
  const current = String(option.currentValue);
  const known = agentConfigOffers(option, current);
  return (
    <label className="agent-config" title={option.description}>
      <span>{option.name}</span>
      <select value={current} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {known ? null : <option value={current} disabled>{current}</option>}
        {choiceOptions(option)}
      </select>
    </label>
  );
}

const DEFAULT_VALUE = "";

/**
 * One option chosen before launch. `null` keeps the agent's default, which
 * the composer does not claim to know: agents may default differently per project.
 */
export function AgentLaunchConfigControl({
  option,
  value,
  disabled,
  onChange,
}: {
  option: AgentConfigOption;
  value: string | boolean | null;
  disabled: boolean;
  onChange(value: string | boolean | null): void;
}): ReactNode {
  const shown = value === null ? DEFAULT_VALUE : String(value);
  return (
    <label className="agent-prompt__option" title={option.description}>
      <span>{option.name}</span>
      <select
        className="agent-prompt__agent-select"
        value={shown}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === DEFAULT_VALUE ? null : option.type === "boolean" ? next === "true" : next);
        }}
      >
        <option value={DEFAULT_VALUE}>Default</option>
        {option.type === "boolean" ? (
          <>
            <option value="true">On</option>
            <option value="false">Off</option>
          </>
        ) : choiceOptions(option)}
      </select>
    </label>
  );
}
