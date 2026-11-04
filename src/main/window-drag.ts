import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { join } from "node:path";
import { validWindowDragRegions, type WindowDragRegions } from "../shared/window-drag";

export function createWindowDrag(getWindowPointer: () => Pointer | null): (regions: WindowDragRegions) => void {
  if (process.platform !== "darwin") return () => {};
  // Main is app/bun/index.js; copy assets live at app/native/.
  const library = dlopen(join(import.meta.dirname, "../native/libWindowDrag.dylib"), {
    db_set_window_drag_regions: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.void },
  });
  return (regions) => {
    const pointer = getWindowPointer();
    if (!pointer) return;
    // Invalid or excessive geometry must release hit testing, never leave a
    // stale native surface intercepting controls that moved underneath it.
    const safe = validWindowDragRegions(regions) ? regions : { width: 1, height: 1, drag: [], exclude: [] };
    library.symbols.db_set_window_drag_regions(pointer, Buffer.from(`${JSON.stringify(safe)}\0`));
  };
}
