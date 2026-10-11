import { useCallback, useSyncExternalStore } from "react";
import type { ComponentActionSelections } from "../../shared/contracts";
import { paletteRecentsStore } from "../lib/palette-recents";

/** The active dashboard's recent palette runs, recorded as the palette runs them. */
export function usePaletteRecents(dashboardPath: string | null) {
  const recents = useSyncExternalStore(
    paletteRecentsStore.subscribe,
    useCallback(() => paletteRecentsStore.get(dashboardPath), [dashboardPath]),
  );
  const record = useCallback((actionId: string, selections?: ComponentActionSelections) => {
    paletteRecentsStore.record(dashboardPath, { actionId, ...(selections ? { selections } : {}) });
  }, [dashboardPath]);
  const forget = useCallback((configPath: string) => paletteRecentsStore.forget(configPath), []);
  return { recents, record, forget };
}
