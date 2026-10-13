import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateAction, UpdateState } from "../../shared/updates";
import { host } from "../lib/rpc-client";
import { errorMessage } from "./app-utils";

/** One update state for Settings, palette actions, and shortcuts. */
export function useAppUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (inFlight.current || refreshing) return;
      refreshing = true;
      const request = generation.current;
      try {
        const next = await host.getUpdateState();
        if (active && request === generation.current) setState(next);
      } catch (caught) {
        if (active && request === generation.current) setError(errorMessage(caught));
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const act = useCallback(async (action: UpdateAction) => {
    if (inFlight.current) throw new Error("An update request is already running.");
    inFlight.current = true;
    generation.current++;
    setPending(true); setError("");
    try {
      const next = await host.updateAction(action);
      setState(next);
      if (next.phase === "problem") throw new Error(next.message);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally { inFlight.current = false; setPending(false); }
  }, []);
  return { state, error, pending, act };
}

export type AppUpdatesController = ReturnType<typeof useAppUpdates>;
