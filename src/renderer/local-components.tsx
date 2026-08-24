import React, {
  Fragment,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { jsxDEV } from "react/jsx-dev-runtime";
import type {
  CompiledLocalComponent,
  LocalComponentRenderProps,
} from "../shared/contracts";

type LocalComponent = React.ComponentType<LocalComponentRenderProps>;
const EMPTY_LOADED_COMPONENTS: ReadonlyMap<string, LoadedLocalComponent> = new Map();

export interface LoadedLocalComponent {
  componentId: string;
  revision: string;
  component: LocalComponent | null;
  loading: boolean;
  error: string | null;
}

interface ComponentRuntimeBridge {
  React: typeof React;
  Fragment: typeof Fragment;
  createElement: typeof createElement;
  jsx: typeof jsx;
  jsxs: typeof jsxs;
  jsxDEV: typeof jsxDEV;
  defineComponent: <Props>(
    component: React.ComponentType<LocalComponentRenderProps<Props>>,
  ) => React.ComponentType<LocalComponentRenderProps<Props>>;
  useCallback: typeof useCallback;
  useContext: typeof useContext;
  useEffect: typeof useEffect;
  useId: typeof useId;
  useImperativeHandle: typeof useImperativeHandle;
  useLayoutEffect: typeof useLayoutEffect;
  useMemo: typeof useMemo;
  useReducer: typeof useReducer;
  useRef: typeof useRef;
  useState: typeof useState;
  useSyncExternalStore: typeof useSyncExternalStore;
  useTransition: typeof useTransition;
}

declare global {
  var __DASH_BORED_COMPONENT_RUNTIME__: ComponentRuntimeBridge | undefined;
}

export function installComponentRuntime(): void {
  if (globalThis.__DASH_BORED_COMPONENT_RUNTIME__) return;

  const bridge: ComponentRuntimeBridge = {
    React,
    Fragment,
    createElement,
    jsx,
    jsxs,
    jsxDEV,
    defineComponent: (component) => component,
    useCallback,
    useContext,
    useEffect,
    useId,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
    useTransition,
  };

  Object.defineProperty(globalThis, "__DASH_BORED_COMPONENT_RUNTIME__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(bridge),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function styleId(component: CompiledLocalComponent): string {
  return `dash-bored-component:${component.componentId}:${component.revision}`;
}

export function useLocalComponents(
  components: CompiledLocalComponent[],
  scope: string | null,
): ReadonlyMap<string, LoadedLocalComponent> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedLocalComponent>>(
    () => new Map(),
  );
  const loadedRef = useRef(loaded);
  const scopeRef = useRef(scope);
  const stylesRef = useRef(new Map<string, {
    revision: string;
    element: HTMLStyleElement;
  }>());
  const signature = components
    .map((component) => `${component.componentId}:${component.revision}`)
    .join("\u0000");
  const targetRef = useRef({ scope, signature });
  loadedRef.current = loaded;
  targetRef.current = { scope, signature };

  useEffect(() => {
    let cancelled = false;
    const blobUrls = new Set<string>();
    const scopeChanged = scopeRef.current !== scope;
    if (scopeChanged) {
      for (const style of stylesRef.current.values()) style.element.remove();
      stylesRef.current.clear();
      scopeRef.current = scope;
    }

    const nextLoaded = scopeChanged
      ? new Map<string, LoadedLocalComponent>()
      : new Map(loadedRef.current);
    const desiredIds = new Set(components.map((component) => component.componentId));
    for (const id of nextLoaded.keys()) {
      if (!desiredIds.has(id)) nextLoaded.delete(id);
    }
    for (const [id, style] of stylesRef.current) {
      if (!desiredIds.has(id)) {
        style.element.remove();
        stylesRef.current.delete(id);
      }
    }

    for (const compiled of components) {
      const existing = nextLoaded.get(compiled.componentId);
      if (existing?.revision === compiled.revision && !existing.loading) continue;

      nextLoaded.set(compiled.componentId, {
        componentId: compiled.componentId,
        revision: existing?.revision ?? compiled.revision,
        component: existing?.component ?? null,
        loading: true,
        error: null,
      });

      try {
        const blob = new Blob([compiled.javascript], {
          type: "text/javascript;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        blobUrls.add(url);

        void import(/* @vite-ignore */ url)
          .then((module: Record<string, unknown>) => {
            URL.revokeObjectURL(url);
            blobUrls.delete(url);
            if (
              cancelled ||
              targetRef.current.scope !== scope ||
              targetRef.current.signature !== signature
            ) return;

            const component = module.default;
            if (typeof component !== "function") {
              throw new Error(
                `Local component ${compiled.componentId} does not have a component default export.`,
              );
            }

            const previousStyle = stylesRef.current.get(compiled.componentId);
            let replacementStyle: HTMLStyleElement | null = null;
            if (compiled.css.trim()) {
              replacementStyle = document.createElement("style");
              replacementStyle.dataset.dashBoredComponent = styleId(compiled);
              replacementStyle.textContent = compiled.css;
              document.head.append(replacementStyle);
              stylesRef.current.set(compiled.componentId, {
                revision: compiled.revision,
                element: replacementStyle,
              });
            } else {
              stylesRef.current.delete(compiled.componentId);
            }

            setLoaded((current) => {
              const next = new Map(current);
              next.set(compiled.componentId, {
                componentId: compiled.componentId,
                revision: compiled.revision,
                component: component as LocalComponent,
                loading: false,
                error: null,
              });
              loadedRef.current = next;
              return next;
            });

            if (previousStyle?.element !== replacementStyle) {
              requestAnimationFrame(() => previousStyle?.element.remove());
            }
          })
          .catch((error: unknown) => {
            URL.revokeObjectURL(url);
            blobUrls.delete(url);
            if (
              cancelled ||
              targetRef.current.scope !== scope ||
              targetRef.current.signature !== signature
            ) return;

            setLoaded((current) => {
              const next = new Map(current);
              const previous = next.get(compiled.componentId);
              next.set(compiled.componentId, {
                componentId: compiled.componentId,
                revision: previous?.revision ?? compiled.revision,
                component: previous?.component ?? null,
                loading: false,
                error: errorMessage(error),
              });
              loadedRef.current = next;
              return next;
            });
          });
      } catch (error) {
        nextLoaded.set(compiled.componentId, {
          componentId: compiled.componentId,
          revision: existing?.revision ?? compiled.revision,
          component: existing?.component ?? null,
          loading: false,
          error: errorMessage(error),
        });
      }
    }

    loadedRef.current = nextLoaded;
    setLoaded(nextLoaded);

    return () => {
      cancelled = true;
      for (const url of blobUrls) URL.revokeObjectURL(url);
    };
  }, [scope, signature]);

  useEffect(() => () => {
    for (const style of stylesRef.current.values()) style.element.remove();
    stylesRef.current.clear();
  }, []);

  return scopeRef.current === scope ? loaded : EMPTY_LOADED_COMPONENTS;
}

interface ErrorBoundaryProps {
  resetKey: string;
  name: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: string | null;
  resetKey: string;
}

export class LocalComponentErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: errorMessage(error) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { error: null, resetKey: props.resetKey };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="component-state component-state--error" role="alert">
          <strong>{this.props.name} crashed</strong>
          <span>{this.state.error}</span>
        </div>
      );
    }

    return this.props.children;
  }
}
