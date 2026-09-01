import { useEffect, useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { stringProp } from "../shared";

export default function Tabs({ props, children }: ComponentRendererProps): ReactNode {
  const panels = children?.type === "managed" ? children.items : [];
  const requestedDefault = props.defaultTab;
  const defaultIndex =
    typeof requestedDefault === "number" &&
    Number.isInteger(requestedDefault) &&
    requestedDefault >= 0 &&
    requestedDefault < panels.length
      ? requestedDefault
      : 0;
  const [active, setActive] = useState(defaultIndex);
  const id = useId().replaceAll(":", "");

  useEffect(() => {
    if (active >= panels.length) setActive(defaultIndex);
  }, [active, defaultIndex, panels.length]);

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % panels.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + panels.length) % panels.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = panels.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActive(nextIndex);
    document.getElementById(`${id}-tab-${nextIndex}`)?.focus();
  }

  if (panels.length === 0) return <div className="component-state">This tab group has no tabs.</div>;
  return (
    <section className="tabs">
      <div className="tabs__list" role="tablist" aria-label={stringProp(props, ["label"], "Dashboard sections")}>
        {panels.map((panel, index) => {
          const selected = index === active;
          return (
            <button
              className="tabs__tab"
              id={`${id}-tab-${index}`}
              key={panel.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(event) => selectFromKeyboard(event, index)}
            >
              {typeof panel.metadata.label === "string" && panel.metadata.label.trim() ? panel.metadata.label : panel.displayName}
            </button>
          );
        })}
      </div>
      {panels.map((panel, index) => (
        <div
          className="tabs__panel"
          id={`${id}-panel-${index}`}
          key={panel.id}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${index}`}
          hidden={index !== active}
        >
          {panel.render({ visible: index === active })}
        </div>
      ))}
    </section>
  );
}
