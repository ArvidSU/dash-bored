import { expect, test } from "bun:test";
import { constants } from "node:os";
import { signalName } from "../../src/core/process-signal";

test("signalName keeps names and maps numeric signal codes to names", () => {
  expect(signalName(null)).toBeNull();
  expect(signalName(undefined)).toBeNull();
  expect(signalName("SIGTERM")).toBe("SIGTERM");
  expect(signalName(constants.signals.SIGKILL)).toBe("SIGKILL");
  expect(signalName(999)).toBe("signal 999");
});
