import type { ReactNode } from "react";
import type {
  ComponentRenderedChildren,
  LocalComponentHost,
} from "../../shared/contracts";

export interface ComponentRendererProps {
  props: Record<string, unknown>;
  children?: ComponentRenderedChildren;
  host: LocalComponentHost;
}

export type PackagedComponent = (props: ComponentRendererProps) => ReactNode;
