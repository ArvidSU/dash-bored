import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const generator = resolve(import.meta.dirname, "../../scripts/generate-component-sdk.ts");

describe("generated component SDK", () => {
  test("committed declarations and embedded assets match the public API sources", async () => {
    const child = Bun.spawn({ cmd: [process.execPath, generator, "--check"], stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(exitCode).toBe(0);
  }, { timeout: 15_000 });
});
