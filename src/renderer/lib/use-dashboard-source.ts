import { useContext, useEffect, useState } from "react";
import type { LocalComponentHost } from "../../shared/contracts";
import { ComponentVisibilityContext } from "../composition/ComponentCompositor";
import { readDashboardSource, type DashboardSource } from "./source";

export type DashboardSourceState = {
  value?: unknown;
  error?: string;
  loading: boolean;
  updatedAt?: Date;
};

export function useDashboardSource(
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
