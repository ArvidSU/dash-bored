import type { AgentSetupOption, DetectedAgent, KnownAgent } from "./agent-session";

/** Pure setup projection. Discovery never downloads; only explicit IDs opt in. */
export function agentSetup(
  catalog: readonly KnownAgent[],
  installed: readonly DetectedAgent[],
  enabledIds: readonly string[] | undefined,
  packageRunner: "npx" | "bunx" | null,
): { setup: AgentSetupOption[]; detected: DetectedAgent[] } {
  const setup = catalog.map((agent): AgentSetupOption => {
    const local = installed.find((item) => item.id === agent.id);
    const enabled = enabledIds ? enabledIds.includes(agent.id) : Boolean(local);
    const args = agent.command.split(/\s+/).slice(1).join(" ");
    const command = local?.command ?? (agent.package && packageRunner
      ? `${packageRunner}${packageRunner === "npx" ? " -y" : ""} ${agent.package}${args ? ` ${args}` : ""}`
      : null);
    return {
      id: agent.id, enabled, installed: Boolean(local), command,
      ...(command ? {} : { needs: agent.package ? "Install Node.js (npx) or Bun, then refresh." : "Install the agent, then refresh." }),
    };
  });
  const detected = catalog.flatMap((agent): DetectedAgent[] => {
    const option = setup.find((item) => item.id === agent.id)!;
    return option.enabled && option.command ? [{
      id: agent.id, name: agent.name, command: option.command, resumable: agent.resume !== undefined,
    }] : [];
  });
  return { setup, detected };
}
