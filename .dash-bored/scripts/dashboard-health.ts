import { emit } from "./lib/run";

interface ValidationDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface HealthStatus {
  state: "healthy" | "warning" | "error";
  detail: string;
}

/** Map `dash-bored validate --json` output to a status tile. */
export function dashboardHealth(output: string): HealthStatus {
  const result = JSON.parse(output) as { ok: boolean; diagnostics?: ValidationDiagnostic[] };
  const diagnostics = result.diagnostics ?? [];
  const errors = diagnostics.filter((item) => item.severity === "error");
  const warnings = diagnostics.filter((item) => item.severity === "warning");
  if (!result.ok || errors.length) {
    return { state: "error", detail: `${errors.length} error${errors.length === 1 ? "" : "s"} · ${errors[0]?.message ?? "validation failed"}` };
  }
  if (warnings.length) {
    return { state: "warning", detail: `${warnings.length} warning${warnings.length === 1 ? "" : "s"} · ${warnings[0]!.message}` };
  }
  return { state: "healthy", detail: "Config, lock, and component tree validate." };
}

if (import.meta.main) {
  const result = Bun.spawnSync(["bun", "./src/cli/index.ts", "validate", ".", "--json"], { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  try {
    emit(dashboardHealth(stdout));
  } catch {
    process.stderr.write(new TextDecoder().decode(result.stderr).trim() || "Validation produced no JSON.\n");
    process.exit(1);
  }
}
