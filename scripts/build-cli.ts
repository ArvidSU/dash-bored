import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(import.meta.dirname, "../dist/tools");
const outputPath = resolve(
  outputDirectory,
  process.platform === "win32" ? "dash-bored.exe" : "dash-bored",
);
await mkdir(outputDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dirname, "../src/cli/index.ts")],
  compile: { outfile: outputPath },
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  console.log(`Built dash-bored CLI: ${outputPath}`);
}
