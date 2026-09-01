import {
  lazy,
  Suspense,
  type ComponentType,
} from "react";
import type { ReactNode } from "react";
import { CapabilityGate, stringProp } from "./builtins/shared";
import type { ComponentRendererProps, PackagedComponent } from "./builtins/types";

function Webview({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const url = stringProp(props, ["url", "src"]);
  if (!componentHost.webview) {
    return (
      <CapabilityGate title="Embedded page">
        Trust this project to load its configured web page.
      </CapabilityGate>
    );
  }
  return componentHost.webview.render({ url });
}

const LazyTabs = lazy(() => import("./builtins/tabs"));
const LazyGroup = lazy(() => import("./builtins/group"));
const LazyCard = lazy(() => import("./builtins/card"));
const LazyChart = lazy(() => import("./builtins/chart"));
const LazyLiveChart = lazy(() => import("./builtins/live-chart"));
const LazyFile = lazy(() => import("./builtins/file"));
const LazyEnv = lazy(() => import("./builtins/env"));
const LazyTodoList = lazy(() => import("./builtins/todo-list").then(({ TodoList }) => ({ default: TodoList })));
const LazyText = lazy(() => import("./builtins/text"));
const LazyStatus = lazy(() => import("./builtins/status"));
const LazyCommand = lazy(() => import("./builtins/command"));
const LazyMarkdown = lazy(() => import("./builtins/markdown"));

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
  "@dash-bored/tabs": lazyBuiltin(LazyTabs),
  "@dash-bored/card": lazyBuiltin(LazyCard),
  "@dash-bored/text": lazyBuiltin(LazyText),
  "@dash-bored/markdown": lazyBuiltin(LazyMarkdown),
  "@dash-bored/status": lazyBuiltin(LazyStatus),
  "@dash-bored/chart": lazyBuiltin(LazyChart),
  "@dash-bored/live-chart": lazyBuiltin(LazyLiveChart),
  "@dash-bored/command": lazyBuiltin(LazyCommand),
  "@dash-bored/file": lazyBuiltin(LazyFile),
  "@dash-bored/env": lazyBuiltin(LazyEnv),
  "@dash-bored/todo-list": lazyBuiltin(LazyTodoList),
  "@dash-bored/webview": Webview,
});

export function packagedComponent(reference: string): PackagedComponent | undefined {
  return PACKAGED_COMPONENTS[reference];
}
