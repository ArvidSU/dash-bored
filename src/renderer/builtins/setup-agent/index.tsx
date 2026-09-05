import { useState } from "react";
import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate } from "../shared";
import "./setup-agent.css";

export default function SetupAgent({ host }: ComponentRendererProps): ReactNode {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = host.environment?.values.find((entry) => entry.key === "DASH_BORED_AGENT");
  const command = configured?.value?.trim() || "codex exec";
  const missing = configured?.source === "unset" || !configured?.value?.trim();
  const setupWithAgent = host.dashboard.setupWithAgent;

  async function start(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await setupWithAgent?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  if (!setupWithAgent) {
    return <CapabilityGate title="Set up this dashboard">Trust this project to run its configured agent.</CapabilityGate>;
  }

  return (
    <div className="setup-agent">
      <strong>Dashboard agent</strong>
      <span>{missing ? "Choose a CLI agent in Settings → General → Dashboard agent." : `Runs ${command}`}</span>
      {configured && !missing ? <small>Command source: {configured.source === "app" ? "App settings" : configured.source}</small> : null}
      <button className="button button--primary" type="button" onClick={() => void start()} disabled={pending}>
        {pending ? "Starting…" : "Set up this dashboard"}
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
