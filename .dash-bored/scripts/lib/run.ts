/** Run a command for a dashboard source script, exiting with its stderr on failure. */
export function runOrExit(command: string[], cwd = process.env.DASH_BORED_CWD || "."): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    process.stderr.write(`${stderr || `${command.join(" ")} failed`}\n`);
    process.exit(result.exitCode || 1);
  }
  return new TextDecoder().decode(result.stdout);
}

export function emit(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
