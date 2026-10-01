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
  disableWebViewOcclusionDetection(window: Pointer): number;
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
    const object = dlopen(library, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } });
    const indexed = dlopen(library, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr } });
    const onMainThread = dlopen(library, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void },
    });
    const selector = (name: string) => base.symbols.sel_registerName(Buffer.from(`${name}\0`)) as Pointer | null;
    const windowClass = base.symbols.objc_getClass(Buffer.from("NSWindow\0")) as Pointer | null;
    const isKindOfClass = selector("isKindOfClass:");
    const windowNumberSelector = selector("windowNumber");
    const webViewClass = base.symbols.objc_getClass(Buffer.from("WKWebView\0")) as Pointer | null;
    const occlusionSetter = selector("_setWindowOcclusionDetectionEnabled:");
    const contentView = selector("contentView");
    const subviews = selector("subviews");
    const count = selector("count");
    const objectAtIndex = selector("objectAtIndex:");
    const respondsToSelector = selector("respondsToSelector:");
    const performOnMainThread = selector("performSelectorOnMainThread:withObject:waitUntilDone:");
    const webViewsIn = (view: Pointer | null, found: Pointer[]): Pointer[] => {
      if (!view || !webViewClass) return found;
      if (binary.symbols.objc_msgSend(view, isKindOfClass, webViewClass)) return [...found, view];
      const children = object.symbols.objc_msgSend(view, subviews) as Pointer | null;
      const total = children ? Number(unary.symbols.objc_msgSend(children, count)) : 0;
      for (let index = 0; index < total; index += 1) {
        found = webViewsIn(indexed.symbols.objc_msgSend(children, objectAtIndex, index) as Pointer | null, found);
      }
      return found;
    };
    objc = {
      selector,
      disableWebViewOcclusionDetection(window) {
        if (!windowClass || !occlusionSetter || !contentView || !performOnMainThread) return 0;
        if (!binary.symbols.objc_msgSend(window, isKindOfClass, windowClass)) return 0;
        const webViews = webViewsIn(object.symbols.objc_msgSend(window, contentView) as Pointer | null, [])
          .filter((webView) => binary.symbols.objc_msgSend(webView, respondsToSelector, occlusionSetter));
        // A nil object is the BOOL NO argument; AppKit and WebKit must be
        // touched on the main thread, which is not Bun's thread here.
        for (const webView of webViews) onMainThread.symbols.objc_msgSend(webView, performOnMainThread, occlusionSetter, null, false);
        return webViews.length;
      },
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
 * Keeps the window's WKWebViews rendering while other windows cover it.
 * WebKit otherwise pauses `requestAnimationFrame` and painting for an occluded
 * window, so agent requests that wait for a paint would stall until the user
 * focused the app, and captures would show stale content. Uses WebKit's
 * `_setWindowOcclusionDetectionEnabled:`, which automation drivers rely on.
 * Call it while the window is visible: WebKit re-evaluates visibility only on
 * the next window-state change, so disabling detection for an already covered
 * window does not resume it. A minimized or hidden window still stops
 * rendering. Returns how many web views were updated.
 */
export function keepWindowRenderingWhenOccluded(windowPointer: Pointer | null): number {
  if (process.platform !== "darwin" || windowPointer === null) return 0;
  return objcRuntime()?.disableWebViewOcclusionDetection(windowPointer) ?? 0;
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
