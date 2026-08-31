import type { ReactNode } from "react";

export function stringProp(
  props: Record<string, unknown>,
  names: string[],
  fallback = "",
): string {
  for (const name of names) {
    if (typeof props[name] === "string") return props[name];
  }
  return fallback;
}

export function CapabilityGate({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="component-state component-state--locked">
      <span className="component-state__icon" aria-hidden="true">
        ◇
      </span>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}
