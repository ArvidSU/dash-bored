import {
  lazy,
  Suspense,
  type ComponentType,
} from "react";
import type { ReactNode } from "react";
import type { ComponentRendererProps, PackagedComponent } from "./types";

const LazyTabs = lazy(() => import("./tabs"));
const LazyGroup = lazy(() => import("./group"));
const LazyConditional = lazy(() => import("./conditional"));
const LazyCard = lazy(() => import("./card"));
const LazyChart = lazy(() => import("./chart"));
const LazyLiveChart = lazy(() => import("./live-chart"));
const LazyEnv = lazy(() => import("./env"));
const LazyTodoList = lazy(() => import("./todo-list").then(({ TodoList }) => ({ default: TodoList })));
const LazyWebview = lazy(() => import("./webview"));
const LazyStatus = lazy(() => import("./status"));
const LazyCommand = lazy(() => import("./command"));
const LazyMarkdown = lazy(() => import("./markdown"));

function ComponentLoading(): ReactNode {
  return <div className="component-state">Loading component…</div>;
}

function lazyBuiltin(
  Component: ComponentType<ComponentRendererProps>,
): PackagedComponent {
  return (props) => (
    <Suspense fallback={<ComponentLoading />}>
      <Component {...props} />
    </Suspense>
  );
}

const PACKAGED_COMPONENTS: Readonly<Record<string, PackagedComponent>> = Object.freeze({
  "@dash-bored/group": lazyBuiltin(LazyGroup),
  "@dash-bored/conditional": lazyBuiltin(LazyConditional),
  "@dash-bored/tabs": lazyBuiltin(LazyTabs),
  "@dash-bored/card": lazyBuiltin(LazyCard),
  "@dash-bored/markdown": lazyBuiltin(LazyMarkdown),
  "@dash-bored/status": lazyBuiltin(LazyStatus),
  "@dash-bored/chart": lazyBuiltin(LazyChart),
  "@dash-bored/live-chart": lazyBuiltin(LazyLiveChart),
  "@dash-bored/command": lazyBuiltin(LazyCommand),
  "@dash-bored/env": lazyBuiltin(LazyEnv),
  "@dash-bored/todo-list": lazyBuiltin(LazyTodoList),
  "@dash-bored/webview": lazyBuiltin(LazyWebview),
});

export function packagedComponent(reference: string): PackagedComponent | undefined {
  return PACKAGED_COMPONENTS[reference];
}
