import { describe, expect, test } from "bun:test";
import { startFixtureServer } from "../helpers/fixture-server";

describe("fixture server startup", () => {
  test("reports stderr when the child exits before readiness", async () => {
    const fixture = startFixtureServer({
      cmd: ["sh", "-c", "printf 'vite failed\\n' >&2; exit 17"],
      url: "http://127.0.0.1:1/ui-harness.html",
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    await expect(fixture.ready).rejects.toThrow(/exited before becoming ready[\s\S]*stderr:\nvite failed/);
    await fixture.stop();
  });

  test("reports the last HTTP probe when readiness times out", async () => {
    const fixture = startFixtureServer({
      cmd: ["sh", "-c", "sleep 2"],
      url: "http://127.0.0.1:1/ui-harness.html",
      timeoutMs: 80,
      requestTimeoutMs: 10,
      pollIntervalMs: 10,
    });

    await expect(fixture.ready).rejects.toThrow(/did not become ready within 80 ms[\s\S]*Last probe:.*Unable to connect/);
    await fixture.stop();
  });
});
