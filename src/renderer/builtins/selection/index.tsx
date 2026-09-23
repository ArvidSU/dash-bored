import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";

/** Core selects the visible handle; this layout component only projects it. */
export default function Selection({ children }: ComponentRendererProps): ReactNode {
  if (children?.type !== "managed") return null;
  return <div className="selection-container">{children.items.map((child) => child.render())}</div>;
}
