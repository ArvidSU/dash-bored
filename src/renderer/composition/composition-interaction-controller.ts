import { useCallback, useEffect, useRef, useState } from "react";
import { cancelActivePointerSession } from "../lib/pointer-session";
import type {
  CompositionDragPayload,
  CompositionPointerState,
  CompositionTarget,
} from "./composition-context";
import type { InsertionTarget, NodePath } from "./dashboard-editor";

export interface CompositionDialogState {
  mode: "add" | "replace" | "configure";
  target?: InsertionTarget;
  reference?: string;
  path?: NodePath;
}

/**
 * Renderer-only composition interaction lifecycle.
 *
 * Opening the library is deliberately clean: it only exposes affordances.
 * Draft creation and every structural mutation remain explicit callers that
 * consume a composition-operation plan. Transient pointer/native drag state
 * always clears together so an interrupted gesture cannot leave an advertised
 * target behind.
 */
export function useCompositionInteractionController() {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [dragging, setDragging] = useState<CompositionDragPayload | null>(null);
  const [pointer, setPointer] = useState<CompositionPointerState | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<CompositionTarget | null>(null);
  const [dialog, setDialog] = useState<CompositionDialogState | null>(null);
  const [removePath, setRemovePath] = useState<NodePath | null>(null);
  // Mirrors the advertised pointer target synchronously so hit-testing in the
  // same frame can hold it (hysteresis) without waiting for a render.
  const pointerRef = useRef<CompositionPointerState | null>(null);
  // A node drag opens the library as its trash target; cancelling restores it.
  const libraryOpenBeforeNodeDrag = useRef(false);

  const clearTransientDrag = useCallback((): void => {
    pointerRef.current = null;
    setDragging(null);
    setPointer(null);
  }, []);

  const closeLibrary = useCallback((): void => {
    setLibraryOpen(false);
    clearTransientDrag();
    setSelectedTarget(null);
  }, [clearTransientDrag]);

  const reset = useCallback((): void => {
    setLibraryOpen(false);
    clearTransientDrag();
    setSelectedTarget(null);
    setDialog(null);
    setRemovePath(null);
  }, [clearTransientDrag]);

  const openLibrary = useCallback((): void => {
    clearTransientDrag();
    setLibraryOpen(true);
  }, [clearTransientDrag]);

  const toggleLibrary = useCallback((): void => {
    if (libraryOpen) closeLibrary();
    else openLibrary();
  }, [closeLibrary, libraryOpen, openLibrary]);

  const beginNodeDrag = useCallback((path: NodePath): void => {
    libraryOpenBeforeNodeDrag.current = libraryOpen;
    pointerRef.current = null;
    setPointer(null);
    setDragging({ type: "node", path });
    setLibraryOpen(true);
  }, [libraryOpen]);

  const beginLibraryDrag = useCallback((reference: string): void => {
    pointerRef.current = null;
    setPointer(null);
    setDragging({ type: "component", reference });
  }, []);

  const updatePointer = useCallback((next: CompositionPointerState | null): void => {
    // Pointer input can outpace painting. Changes inside the same insertion
    // boundary cannot affect the preview, so do not invalidate the tree.
    const current = pointerRef.current;
    if (current === next) return;
    if (
      current !== null
      && next !== null
      && current.nodeId === next.nodeId
      && current.zoneId === next.zoneId
    ) return;
    pointerRef.current = next;
    setPointer(next);
  }, []);

  const currentPointer = useCallback((): CompositionPointerState | null => pointerRef.current, []);

  const selectTarget = useCallback((target: CompositionTarget): void => {
    clearTransientDrag();
    setSelectedTarget(target);
    setLibraryOpen(true);
  }, [clearTransientDrag]);

  const showDialog = useCallback((next: CompositionDialogState): void => {
    setLibraryOpen(false);
    clearTransientDrag();
    setDialog(next);
  }, [clearTransientDrag]);

  const dismissDialog = useCallback((): void => {
    setDialog(null);
    setLibraryOpen(true);
  }, []);
  const requestRemoval = useCallback((path: NodePath): void => {
    setLibraryOpen(false);
    clearTransientDrag();
    setRemovePath(path);
  }, [clearTransientDrag]);
  const dismissRemoval = useCallback((): void => {
    setRemovePath(null);
    setLibraryOpen(true);
  }, []);
  const clearTarget = useCallback((): void => setSelectedTarget(null), []);

  useEffect(() => {
    const cancelTransientDrag = (): void => clearTransientDrag();
    // Native HTML drag and pointer delivery can end outside React's tree.
    // Capture cancellation/lost capture so stale UI never remains droppable.
    window.addEventListener("blur", cancelTransientDrag);
    window.addEventListener("dragend", cancelTransientDrag, true);
    window.addEventListener("pointercancel", cancelTransientDrag, true);
    window.addEventListener("lostpointercapture", cancelTransientDrag, true);
    return () => {
      window.removeEventListener("blur", cancelTransientDrag);
      window.removeEventListener("dragend", cancelTransientDrag, true);
      window.removeEventListener("pointercancel", cancelTransientDrag, true);
      window.removeEventListener("lostpointercapture", cancelTransientDrag, true);
    };
  }, [clearTransientDrag]);

  useEffect(() => {
    if (!dragging) return;
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Capture phase so no other Escape owner (drawer, removal flyout) also
      // reacts: the only effect is abandoning the gesture. The session owner
      // receives "cancel" and ends the drag without committing a drop.
      event.preventDefault();
      event.stopPropagation();
      cancelActivePointerSession();
      clearTransientDrag();
      if (dragging.type === "node" && !libraryOpenBeforeNodeDrag.current) setLibraryOpen(false);
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => window.removeEventListener("keydown", cancelOnEscape, true);
  }, [clearTransientDrag, dragging]);

  return {
    libraryOpen,
    dragging,
    pointer,
    selectedTarget,
    dialog,
    removePath,
    openLibrary,
    closeLibrary,
    toggleLibrary,
    beginNodeDrag,
    beginLibraryDrag,
    updatePointer,
    currentPointer,
    endDrag: clearTransientDrag,
    selectTarget,
    showDialog,
    dismissDialog,
    requestRemoval,
    dismissRemoval,
    clearTarget,
    reset,
  };
}
