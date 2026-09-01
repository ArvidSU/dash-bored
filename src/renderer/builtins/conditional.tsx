import { useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ShellRunResult } from "../../shared/contracts";
import { ComponentVisibilityContext } from "../ComponentCompositor";
import type { ComponentRendererProps } from "./types";
import { childSurface, stringProp } from "./shared";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export function shellConditionSucceeded(result: Pick<ShellRunResult, "exitCode" | "signal" | "timedOut">): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut;
}

export function conditionalVisibility(
  result: Pick<ShellRunResult, "exitCode" | "signal" | "timedOut">,
  invert: boolean,
): boolean {
  const succeeded = shellConditionSucceeded(result);
  return invert ? !succeeded : succeeded;
}

function numberProp(props: Record<string, unknown>, name: string, fallback: number): number {
  const value = props[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringMapProp(props: Record<string, unknown>, name: string): Record<string, string> | undefined {
  const value = props[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.values(value).some((entry) => typeof entry !== "string")) return undefined;
  return value as Record<string, string>;
}

/**
 * Render a tiled child only when its trusted host shell check succeeds. A
 * missing or failed check keeps the child available so a condition cannot
 * silently remove the recovery action it is meant to guard.
 */
export default function Conditional({ props, children, host }: ComponentRendererProps): ReactNode {
  const command = stringProp(props, ["command"]);
  const cwd = stringProp(props, ["cwd"], "");
  const env = stringMapProp(props, "env");
  const invert = props.invert === true;
  const pollIntervalMs = numberProp(props, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = numberProp(props, "timeoutMs", DEFAULT_TIMEOUT_MS);
  const panelVisible = useContext(ComponentVisibilityContext);
  const [showChildren, setShowChildren] = useState(true);

  useEffect(() => {
    const run = host.shell?.run;
    if (!run || command.trim() === "" || !panelVisible) {
      if (!run || command.trim() === "") setShowChildren(true);
      return;
    }

    let cancelled = false;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const result = await run({
          command,
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
          timeoutMs,
        });
        if (!cancelled) setShowChildren(conditionalVisibility(result, invert));
      } catch {
        if (!cancelled) setShowChildren(true);
      } finally {
        checking = false;
      }
    };

    void check();
    const timer = setInterval(() => void check(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [command, cwd, env, host.shell, invert, panelVisible, pollIntervalMs, timeoutMs]);

  return showChildren ? childSurface(children) : null;
}
