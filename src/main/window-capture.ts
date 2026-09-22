import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError } from "../core/index";

export interface CaptureTarget {
  /** Native NSWindow pointer of the window to capture. */
  windowPointer: Pointer | null;
  /** Window frame in global top-left screen points; used when the window number is unavailable. */
  frame: { x: number; y: number; width: number; height: number };
}

export interface ScreenCapturePermission {
  hasAccess(): boolean;
  requestAccess(): boolean;
}

let objc: {
  selector(name: string): Pointer | null;
  windowNumber(window: Pointer): number | null;
} | null | undefined;

function objcRuntime() {
  if (objc !== undefined) return objc;
  try {
    const library = "/usr/lib/libobjc.A.dylib";
    const base = dlopen(library, {
      sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
      objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
    });
    const unary = dlopen(library, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 } });
    const binary = dlopen(library, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool } });
    const selector = (name: string) => base.symbols.sel_registerName(Buffer.from(`${name}\0`)) as Pointer | null;
    const windowClass = base.symbols.objc_getClass(Buffer.from("NSWindow\0")) as Pointer | null;
    const isKindOfClass = selector("isKindOfClass:");
    const windowNumberSelector = selector("windowNumber");
    objc = {
      selector,
      windowNumber(window) {
        if (!windowClass || !isKindOfClass || !windowNumberSelector) return null;
        if (!binary.symbols.objc_msgSend(window, isKindOfClass, windowClass)) return null;
        const value = Number(unary.symbols.objc_msgSend(window, windowNumberSelector));
        return Number.isSafeInteger(value) && value > 0 ? value : null;
      },
    };
  } catch {
    objc = null;
  }
  return objc;
}

/** Resolves the Quartz window number used by `screencapture -l`. */
export function nativeWindowNumber(windowPointer: Pointer | null): number | null {
  if (process.platform !== "darwin" || windowPointer === null) return null;
  return objcRuntime()?.windowNumber(windowPointer) ?? null;
}

/**
 * Captures one app window as PNG through the system `screencapture` tool. The
 * window number captures the window's own content even when it is covered;
 * the frame fallback captures that screen region as currently displayed.
 */
export async function captureWindowPng(
  target: CaptureTarget,
  permission: ScreenCapturePermission,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<Uint8Array<ArrayBuffer>> {
  if (process.platform !== "darwin") {
    throw new CoreError("SCREENSHOT_UNSUPPORTED", "App screenshots are currently supported on macOS only.");
  }
  if (!permission.hasAccess()) {
    permission.requestAccess();
    throw new CoreError(
      "SCREEN_RECORDING_PERMISSION_REQUIRED",
      "dash-bored needs Screen Recording permission to capture its window. Ask the user to allow it in System Settings → Privacy & Security → Screen Recording, relaunch the app, and try again.",
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "dash-bored-capture-"));
  const output = join(directory, "window.png");
  try {
    const windowNumber = nativeWindowNumber(target.windowPointer);
    const { x, y, width, height } = target.frame;
    const selection = windowNumber === null
      ? ["-R", [x, y, width, height].map((value) => Math.round(value)).join(",")]
      : ["-o", "-l", String(windowNumber)];
    const child = spawn(["/usr/sbin/screencapture", "-x", "-t", "png", ...selection, output], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) {
      throw new CoreError("SCREENSHOT_FAILED", `screencapture exited with ${exitCode}: ${stderr.trim() || "no output"}`);
    }
    const png = new Uint8Array(await readFile(output));
    if (png.byteLength === 0) throw new CoreError("SCREENSHOT_FAILED", "screencapture produced an empty image.");
    return png;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
