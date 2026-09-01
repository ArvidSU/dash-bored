import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { childSurface } from "../shared";

export default function Group({ children }: ComponentRendererProps): ReactNode {
  return childSurface(children);
}
