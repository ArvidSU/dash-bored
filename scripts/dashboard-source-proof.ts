import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { name?: string; version?: string };
const output = {
  project: packageJson.name ?? "unknown",
  version: packageJson.version ?? "unknown",
};
process.stdout.write(`${JSON.stringify(output)}\n`);
