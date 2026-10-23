import type { ComponentNode, DashboardConfig } from "./contracts";
/** Declarative composition supplied by an ordinary component package. */
export interface ComponentTemplate {
    reference: string;
    id: string;
    name: string;
    description?: string;
    role?: "starter" | "tutorial";
    root: ComponentNode;
    config?: DashboardConfig;
}
