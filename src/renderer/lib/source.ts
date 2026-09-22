import type { LocalComponentHost } from "../../shared/contracts";

export type DashboardSource = {
  shell?: string; file?: string; http?: string; process?: string; inline?: unknown;
  every?: number; timeoutMs?: number; cwd?: string; env?: Record<string, string>;
};

export function decodeSourceText(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

export async function readDashboardSource(source: DashboardSource, host: LocalComponentHost): Promise<unknown> {
  const kinds = (["shell", "file", "http", "process", "inline"] as const).filter((kind) => kind in source);
  if (kinds.length !== 1) throw new Error("Source must define exactly one of shell, file, http, process, or inline.");
  switch (kinds[0]) {
    case "inline": return source.inline;
    case "shell": {
      if (!host.shell) throw new Error("Source requires process:execute permission.");
      const result = await host.shell.run({ command: source.shell!, cwd: source.cwd, env: source.env, timeoutMs: source.timeoutMs });
      if (result.timedOut || result.exitCode !== 0) throw new Error(`Command failed (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}): ${result.stderr.slice(-500)}`);
      return decodeSourceText(result.stdout);
    }
    case "file": {
      if (!host.filesystem) throw new Error("Source requires filesystem:read permission.");
      return decodeSourceText(await host.filesystem.readText(source.file!));
    }
    case "http": {
      if (!host.http) throw new Error("Source requires network:http permission.");
      const response = await host.http.request({ url: source.http!, timeoutMs: source.timeoutMs });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}: ${response.body.slice(-500)}`);
      return decodeSourceText(response.body);
    }
    case "process": {
      if (!host.processes) throw new Error("Source requires process:observe permission.");
      // The manifest's source.process reference is resolved and namespace-remapped
      // by core tree validation before the renderer receives this props object.
      const snapshot = host.processes.get(source.process!);
      if (snapshot === undefined) throw new Error(`No supervised process exists with id ${source.process}.`);
      return snapshot;
    }
  }
}
