import { describe, expect, spyOn, test } from "bun:test";
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
    // A controlled HTTP response avoids OS-specific connection errors and
    // request-timeout races on a busy machine.
    const probe = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const fixture = startFixtureServer({
      cmd: ["sh", "-c", "sleep 2"],
      url: "http://127.0.0.1:1/ui-harness.html",
      timeoutMs: 80,
      requestTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    try {
      await expect(fixture.ready).rejects.toThrow(/did not become ready within 80 ms[\s\S]*Last probe: HTTP 503/);
    } finally {
      await fixture.stop();
      probe.mockRestore();
    }
  });
});
