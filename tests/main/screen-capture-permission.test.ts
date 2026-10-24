import { expect, test } from "bun:test";
import { resetScreenCapturePermission, screenCapturePermissionCommand, type ScreenCaptureRecoveryOptions } from "../../src/main/screen-capture-permission";

function fixture() {
  const calls: string[] = [];
  let granted = false;
  const options: ScreenCaptureRecoveryOptions = {
    supported: true,
    permission: {
      hasAccess: () => granted,
      requestAccess: () => { calls.push("request"); granted = true; return true; },
    },
    bundleIdentifier: () => "dev.dash-bored.wt-example.dev",
    confirmReset: async () => { calls.push("confirm"); return true; },
    openSettings: () => { calls.push("settings"); },
    reset: async (identifier) => { calls.push(`reset:${identifier}`); granted = false; },
  };
  return { calls, options };
}

test("checking permission is read-only and requesting reports the new grant", async () => {
  const { calls, options } = fixture();
  expect(await screenCapturePermissionCommand("status", options)).toEqual({ supported: true, granted: false });
  expect(calls).toEqual([]);
  expect(await screenCapturePermissionCommand("request", options)).toEqual({ supported: true, granted: true });
  expect(calls).toEqual(["request"]);
});

test("repair confirms and resets only this running bundle, leaving re-request until relaunch", async () => {
  const { calls, options } = fixture();
  expect(await screenCapturePermissionCommand("repair", options)).toEqual({ supported: true, granted: false, reset: true });
  expect(calls).toEqual(["confirm", "reset:dev.dash-bored.wt-example.dev"]);
});

test("cancelling repair leaves the saved decision alone", async () => {
  const { calls, options } = fixture();
  options.confirmReset = async () => false;
  expect((await screenCapturePermissionCommand("repair", options)).reset).toBeUndefined();
  expect(calls).toEqual([]);
});

test("missing or invalid bundle identity cannot become a global reset", async () => {
  for (const identifier of [null, "", " ", "--help", "dev.example;echo bad"]) {
    const { calls, options } = fixture();
    options.bundleIdentifier = () => identifier;
    await expect(screenCapturePermissionCommand("repair", options)).rejects.toThrow("No permissions were reset");
    expect(calls).toEqual([]);
  }
});

test("failed reset is surfaced without requesting permission or opening settings", async () => {
  const { calls, options } = fixture();
  options.reset = async () => { throw new Error("tccutil failed"); };
  await expect(screenCapturePermissionCommand("repair", options)).rejects.toThrow("tccutil failed");
  expect(calls).toEqual(["confirm"]);
});

test("opening settings never requests or resets a grant", async () => {
  const { calls, options } = fixture();
  await screenCapturePermissionCommand("open-settings", options);
  expect(calls).toEqual(["settings"]);
});

test("unsupported systems never call macOS APIs", async () => {
  const { calls, options } = fixture();
  options.supported = false;
  for (const command of ["status", "request", "repair", "open-settings"] as const) {
    expect(await screenCapturePermissionCommand(command, options)).toEqual({ supported: false, granted: false });
  }
  expect(calls).toEqual([]);
});


test("the reset subprocess is scoped to ScreenCapture and the exact bundle, and reports errors", async () => {
  const calls: unknown[] = [];
  let exitCode = 0;
  const spawn = ((args: unknown) => {
    calls.push(args);
    return { exited: Promise.resolve(exitCode), stderr: new Blob(["permission reset failed"]).stream() };
  }) as unknown as typeof Bun.spawn;
  await resetScreenCapturePermission("dev.dash-bored.app", spawn);
  expect(calls).toEqual([["/usr/bin/tccutil", "reset", "ScreenCapture", "dev.dash-bored.app"]]);
  exitCode = 1;
  await expect(resetScreenCapturePermission("dev.dash-bored.app", spawn)).rejects.toThrow("permission reset failed");
  const count = calls.length;
  await expect(resetScreenCapturePermission("", spawn)).rejects.toThrow("No permissions were reset");
  expect(calls).toHaveLength(count);
});
