import { useCallback, useContext, useEffect, useState } from "react";
import type { ComponentActionConfirmation, LocalComponentHost } from "../../shared/contracts";
import { ComponentVisibilityContext } from "../composition/ComponentCompositor";
import { readDashboardSource, type DashboardSource } from "./source";

export type DashboardSourceState = {
  value?: unknown;
  error?: string;
  loading: boolean;
  updatedAt?: Date;
};

/** The permission a source needs that this component's host did not grant, if any. */
export function missingSourcePermission(source: DashboardSource | null, host: LocalComponentHost): string | undefined {
  if (!source) return undefined;
  if (source.shell && !host.shell) return "process:execute";
  if (source.file && !host.filesystem) return "filesystem:read";
  if (source.http && !host.http) return "network:http";
  if (source.process && !host.processes) return "process:observe";
  return undefined;
}

export type SourceComponentOptions = {
  /** Label of the registered `refresh` action. */
  label: string;
  /**
   * Why refresh is disabled when no source is configured. `null` leaves the
   * action enabled for a component whose own non-source reload (a Markdown
   * file) shares the same `refreshes` counter.
   */
  withoutSource: string | null;
  /** Disabled reason when the source's permission is missing. */
  unavailableReason?: (permission: string) => string;
  confirmation?: ComponentActionConfirmation;
};

export type SourceComponent = {
  state: DashboardSourceState;
  /** The missing permission; the source is not read while this is set. */
  unavailable: string | undefined;
  refresh: () => void;
  /** Counts refreshes so a non-source reload can depend on it. */
  refreshes: number;
};

/**
 * The one owner of a source-backed component's loading, capability check,
 * refresh counter, and declared `refresh` action.
 */
export function useSourceComponent(
  source: DashboardSource | null,
  host: LocalComponentHost,
  { label, withoutSource, unavailableReason, confirmation }: SourceComponentOptions,
): SourceComponent {
  const [refreshes, setRefreshes] = useState(0);
  const refresh = useCallback(() => setRefreshes((count) => count + 1), []);
  const unavailable = missingSourcePermission(source, host);
  const state = useLoadedSource(unavailable ? null : source, host, refreshes);
  const reason = unavailable
    ? unavailableReason?.(unavailable) ?? `Trust this project to grant ${unavailable}.`
    : source === null ? withoutSource ?? undefined : undefined;

  useEffect(() => host.actions.register({
    id: "refresh",
    label,
    enabled: reason === undefined,
    disabledReason: reason,
    confirmation,
    run: refresh,
  }), [host.actions, label, reason, refresh, confirmation?.title, confirmation?.message, confirmation?.confirmLabel]);

  return { state, unavailable, refresh, refreshes };
}

function useLoadedSource(
  source: DashboardSource | null,
  host: LocalComponentHost,
  refresh: number,
): DashboardSourceState {
  const visible = useContext(ComponentVisibilityContext);
  const [state, setState] = useState<DashboardSourceState>({ loading: true });
  const processSnapshot = source?.process ? host.processes?.get(source.process) : undefined;
  const sourceKey = JSON.stringify(source);
  const every = typeof source?.every === "number" ? Math.max(1000, Math.min(300000, source.every)) : undefined;

  useEffect(() => {
    if (!visible || !source) return;
    const activeSource = source;
    let cancelled = false;
    let timer: number | undefined;
    async function load(): Promise<void> {
      setState((previous) => ({ ...previous, loading: true, error: undefined }));
      try {
        const value = await readDashboardSource(activeSource, host);
        if (!cancelled) setState({ value, loading: false, updatedAt: new Date() });
      } catch (cause) {
        if (!cancelled) setState((previous) => ({
          ...previous,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      } finally {
        if (!cancelled && every !== undefined) timer = window.setTimeout(() => void load(), every);
      }
    }
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [every, host, refresh, sourceKey, visible]);

  useEffect(() => {
    if (source?.process && processSnapshot !== undefined) {
      setState({ value: processSnapshot, loading: false, updatedAt: new Date() });
    }
  }, [processSnapshot, source?.process]);

  return state;
}
