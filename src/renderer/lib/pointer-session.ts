import { useCallback, useEffect, useMemo, useRef } from "react";

export type PointerSessionFinishReason = "up" | "cancel" | "blur" | "lost" | "replaced";

export interface PointerSession {
  pointerId: number;
  /** Retain the mouse fallback for WebKit hosts that occasionally lose pointerup. */
  mouseUpFallback?: boolean;
  onMove: (event: PointerEvent) => void;
  onFinish: (event: PointerEvent | MouseEvent | null, reason: PointerSessionFinishReason) => void;
}

interface ActivePointerSession extends PointerSession {
  owner: symbol;
}

let activeSession: ActivePointerSession | null = null;
let removeActiveListeners: (() => void) | null = null;

function finishActiveSession(
  event: PointerEvent | MouseEvent | null,
  reason: PointerSessionFinishReason,
): void {
  const current = activeSession;
  if (!current) return;
  activeSession = null;
  removeActiveListeners?.();
  removeActiveListeners = null;
  current.onFinish(event, reason);
}

function installActiveListeners(): void {
  const move = (event: PointerEvent): void => {
    if (activeSession?.pointerId === event.pointerId) activeSession.onMove(event);
  };
  const up = (event: PointerEvent): void => {
    if (activeSession?.pointerId === event.pointerId) finishActiveSession(event, "up");
  };
  const cancel = (event: PointerEvent): void => {
    if (activeSession?.pointerId === event.pointerId) finishActiveSession(event, "cancel");
  };
  const mouseUp = (event: MouseEvent): void => {
    if (activeSession?.mouseUpFallback && event.button === 0) finishActiveSession(event, "up");
  };
  const blur = (): void => finishActiveSession(null, "blur");
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("mouseup", mouseUp);
  window.addEventListener("blur", blur);
  removeActiveListeners = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("mouseup", mouseUp);
    window.removeEventListener("blur", blur);
  };
}

/**
 * Own one cancellation-safe, window-level pointer gesture at a time.
 * Listeners exist only between pointerdown and its terminal event, so mounting
 * a deeply nested dashboard does not multiply idle global listeners.
 */
export function usePointerSession(): {
  start: (session: PointerSession) => void;
  finish: (pointerId: number, event: PointerEvent | MouseEvent | null, reason?: PointerSessionFinishReason) => void;
  cancel: () => void;
} {
  const owner = useRef(Symbol("pointer-session"));

  const start = useCallback((session: PointerSession): void => {
    if (activeSession) finishActiveSession(null, "replaced");
    activeSession = { ...session, owner: owner.current };
    installActiveListeners();
  }, []);
  const finish = useCallback((pointerId: number, event: PointerEvent | MouseEvent | null, reason: PointerSessionFinishReason = "up"): void => {
    if (activeSession?.owner === owner.current && activeSession.pointerId === pointerId) {
      finishActiveSession(event, reason);
    }
  }, []);
  const cancel = useCallback((): void => {
    if (activeSession?.owner === owner.current) finishActiveSession(null, "cancel");
  }, []);

  useEffect(() => cancel, [cancel]);
  return useMemo(() => ({ start, finish, cancel }), [cancel, finish, start]);
}
