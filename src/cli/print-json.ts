/**
 * Prints JSON to stdout, indented on a terminal and compact otherwise.
 *
 * Bun 1.3 drops `console.log` output past the 64 KiB pipe buffer once
 * `process.stdout` has been touched (here, for `isTTY`) and the reader is slow,
 * so large `inspect` and `app actions` payloads arrived truncated in agent
 * pipelines. `process.stdout.write` drains fully before exit.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, process.stdout.isTTY ? 2 : 0)}\n`);
}
