import { CoreError } from "../core/index";
import type { ScreenCaptureCommand, ScreenCaptureStatus } from "../shared/screen-capture";
import type { ScreenCapturePermission } from "./window-capture";

export interface ScreenCaptureRecoveryOptions {
  supported: boolean;
  permission: ScreenCapturePermission;
  bundleIdentifier(): string | null;
  confirmReset(): Promise<boolean>;
  openSettings(): void;
  reset(identifier: string): Promise<void>;
}

function requireBundleIdentifier(identifier: string | null): string {
  // An omitted identifier would turn an app repair into a reset for every app.
  if (!identifier || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(identifier)) {
    throw new CoreError("SCREEN_RECORDING_RESET_FAILED", "Could not identify this app's bundle. No permissions were reset.");
  }
  return identifier;
}

/** Only the desktop UI exposes recovery; capture never resets a user's grant. */
export async function screenCapturePermissionCommand(
  command: ScreenCaptureCommand,
  options: ScreenCaptureRecoveryOptions,
): Promise<ScreenCaptureStatus> {
  if (!options.supported) return { supported: false, granted: false };
  let reset = false;
  switch (command) {
    case "status": break;
    case "request": options.permission.requestAccess(); break;
    case "open-settings": options.openSettings(); break;
    case "repair": {
      const identifier = requireBundleIdentifier(options.bundleIdentifier());
      if (!await options.confirmReset()) break;
      await options.reset(identifier);
      reset = true;
      // Requesting from the existing process can reuse macOS's cached denial.
      // The UI directs the user to relaunch, then request from the new process.
      break;
    }
    default: throw new CoreError("SCREEN_RECORDING_COMMAND_INVALID", "Unknown Screen Recording permission command.");
  }
  return { supported: true, granted: options.permission.hasAccess(), ...(reset ? { reset: true } : {}) };
}

export async function resetScreenCapturePermission(identifier: string, spawn: typeof Bun.spawn = Bun.spawn): Promise<void> {
  requireBundleIdentifier(identifier);
  const child = spawn(["/usr/bin/tccutil", "reset", "ScreenCapture", identifier], { stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) {
    throw new CoreError("SCREEN_RECORDING_RESET_FAILED", `Could not reset Screen Recording permission: ${stderr.trim() || `tccutil exited with ${exitCode}`}`);
  }
}
