import { useCallback, useEffect, useState } from "react";
import type { PackageUpdateCommand, PackageUpdateState } from "../../shared/package-updates";
import { host } from "../lib/rpc-client";
import { errorMessage } from "./app-utils";

/**
 * Package update state for Settings, palette actions, and the Settings badge:
 * read once, then kept current by the host's `packageUpdates` pushes.
 */
export function usePackageUpdates() {
  const [state, setState] = useState<PackageUpdateState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    let pushed = false;
    const unsubscribe = host.subscribe((event) => {
      if (event.type !== "package-updates") return;
      pushed = true;
      setState(event.state);
    });
    // A push that lands before this read is newer than its answer.
    host.getPackageUpdates().then(
      (initial) => { if (active && !pushed) setState(initial); },
      (caught: unknown) => { if (active) setError(errorMessage(caught)); },
    );
    return () => { active = false; unsubscribe(); };
  }, []);
  const command = useCallback(async (next: PackageUpdateCommand) => {
    setPending(true);
    setError("");
    try {
      await host.packageUpdateCommand(next);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally {
      setPending(false);
    }
  }, []);
  return { state, error, pending, command };
}

export type PackageUpdatesController = ReturnType<typeof usePackageUpdates>;
