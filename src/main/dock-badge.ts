import { dlopen, FFIType, type Pointer } from "bun:ffi";

let setter: ((label: string | null) => void) | null | undefined;

function dockBadgeSetter(): ((label: string | null) => void) | null {
  if (setter !== undefined) return setter;
  setter = null;
  if (process.platform !== "darwin") return setter;
  try {
    const library = "/usr/lib/libobjc.A.dylib";
    const base = dlopen(library, {
      sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
      objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
    });
    const object = dlopen(library, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } });
    const fromUtf8 = dlopen(library, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.ptr } });
    const onMainThread = dlopen(library, {
      objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void },
    });
    const selector = (name: string) => base.symbols.sel_registerName(Buffer.from(`${name}\0`)) as Pointer | null;
    const applicationClass = base.symbols.objc_getClass(Buffer.from("NSApplication\0")) as Pointer | null;
    const stringClass = base.symbols.objc_getClass(Buffer.from("NSString\0")) as Pointer | null;
    const sharedApplication = selector("sharedApplication");
    const dockTileSelector = selector("dockTile");
    const setBadgeLabel = selector("setBadgeLabel:");
    const stringWithUtf8 = selector("stringWithUTF8String:");
    const performOnMainThread = selector("performSelectorOnMainThread:withObject:waitUntilDone:");
    if (!applicationClass || !stringClass || !sharedApplication || !dockTileSelector || !setBadgeLabel || !stringWithUtf8 || !performOnMainThread) {
      return setter;
    }
    setter = (label) => {
      const application = object.symbols.objc_msgSend(applicationClass, sharedApplication) as Pointer | null;
      const dockTile = application ? object.symbols.objc_msgSend(application, dockTileSelector) as Pointer | null : null;
      if (!dockTile) return;
      const value = label === null
        ? null
        : fromUtf8.symbols.objc_msgSend(stringClass, stringWithUtf8, Buffer.from(`${label}\0`)) as Pointer | null;
      // AppKit UI state belongs to the main thread; the argument is retained until it runs.
      onMainThread.symbols.objc_msgSend(dockTile, performOnMainThread, setBadgeLabel, value, false);
    };
  } catch {
    setter = null;
  }
  return setter;
}

/** Show `count` on the dock icon, or clear it at 0. Best effort: a missing runtime leaves the dock alone. */
export function setDockBadge(count: number): void {
  try {
    dockBadgeSetter()?.(count > 0 ? String(count) : null);
  } catch (error) {
    console.error("Could not update the dock badge.", error);
  }
}
