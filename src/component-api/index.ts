/** Public authoring entry. Only declarations ship; implementation remains app-owned. */
import type { ComponentType } from "react";
import type { LocalComponentRenderProps, TerminalSurfaceProps } from "../shared/contracts";
import type { ThemeAppearance, ThemeCatalogItem, ThemeTokens } from "../shared/themes";

export type {
  LocalComponentRenderProps, LocalComponentHost, ComponentChildHandle, ComponentRenderedChildren,
  ComponentAction, ComponentActionChoice, ComponentActionOption, ComponentActionSelections,
  ComponentActionConfirmation, ResolvedComponentAction, ActionInvocationState, ActionInvocation,
  ComponentEnvironmentSnapshot, ComponentAgentLaunch, ProcessSnapshot, ProcessRunSnapshot,
  ProcessLogEntry, ProcessPhase, HttpResponsePayload, ShellRunResult, TerminalSurfaceProps,
  ComponentManifest, ComponentChildrenDefinition, ComponentProcessResourceDefinition, Permission,
} from "../shared/contracts";
export type { ThemeTokens, ThemeToken, ThemeAppearance, ThemeCatalogItem } from "../shared/themes";
export type HttpRequest = Omit<import("../shared/contracts").HttpRequest, "nodeId">;
export type ShellRunRequest = Omit<import("../shared/contracts").ShellRunRequest, "nodeId">;
export interface ComponentTheme {
  reference: string;
  appearance: ThemeAppearance;
  tokens: ThemeTokens;
  catalog: ThemeCatalogItem[];
  errors: string[];
}
export declare function defineComponent<Props = Record<string, unknown>>(
  component: ComponentType<LocalComponentRenderProps<Props>>,
): ComponentType<LocalComponentRenderProps<Props>>;
/** Reactively reflects the host's active theme. */
export declare function useTheme(): ComponentTheme;
/** False while a mounted component is hidden; use to pause future polling. */
export declare function useComponentVisibility(): boolean;
/** Includes bounded asynchronous work in screenshot/agent idle detection. Returns the same promise. */
export declare function trackActivity<T>(work: Promise<T>): Promise<T>;
export declare const TerminalSurface: ComponentType<TerminalSurfaceProps>;
export {
  createElement, Fragment, useCallback, useContext, useDebugValue, useDeferredValue, useEffect,
  useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useReducer, useRef,
  useState, useSyncExternalStore, useTransition,
} from "react";
