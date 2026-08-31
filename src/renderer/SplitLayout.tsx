import { useEffect, useId, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  ReactNode,
} from "react";
import {
  clampSplitRatioForSize,
  normalizeSplitRatio,
  normalizeVerticalSplitSize,
  SPLIT_SEPARATOR_PX,
} from "./split-layout";

interface SplitLayoutProps {
  axis: "horizontal" | "vertical";
  first: ReactNode;
  second: ReactNode;
  ratio: number;
  defaultRatio: number;
  minFirstPx: number;
  minSecondPx: number;
  resizable?: boolean;
  label: string;
  verticalSize?: number;
  onRatioChange?: (ratio: number, verticalSize?: number) => void;
  onRatioReset?: () => void;
}

export function SplitLayout({
  axis,
  first,
  second,
  ratio,
  defaultRatio,
  minFirstPx,
  minSecondPx,
  resizable = true,
  label,
  verticalSize: savedVerticalSize,
  onRatioChange,
  onRatioReset,
}: SplitLayoutProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const lastDragRatio = useRef<number | null>(null);
  const pinnedVerticalSize = useRef<number | null>(
    axis === "vertical" ? normalizeVerticalSplitSize(savedVerticalSize) ?? null : null,
  );
  const [transientRatio, setTransientRatio] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [verticalSize, setVerticalSize] = useState<number | null>(pinnedVerticalSize.current);
  const instanceId = useId().replaceAll(":", "");
  const firstId = `${instanceId}-first`;
  const secondId = `${instanceId}-second`;
  const effectiveRatio = normalizeSplitRatio(transientRatio ?? ratio);
  const enabled = resizable && onRatioChange !== undefined;
  const percent = Math.round(effectiveRatio * 100);
  const defaultPercent = Math.round(normalizeSplitRatio(defaultRatio) * 100);
  const verticalRatioSized = axis === "vertical" && verticalSize !== null;
  const style = {
    "--split-first-size": `${effectiveRatio * 100}fr`,
    "--split-second-size": `${(1 - effectiveRatio) * 100}fr`,
    "--split-separator-size": `${SPLIT_SEPARATOR_PX}px`,
    ...(axis === "vertical" && verticalSize !== null
      ? { height: `${verticalSize}px` }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    const next = axis === "vertical" ? normalizeVerticalSplitSize(savedVerticalSize) ?? null : null;
    pinnedVerticalSize.current = next;
    setVerticalSize(next);
  }, [axis, savedVerticalSize]);

  function pinVerticalHeight(): number | undefined {
    if (axis !== "vertical") return undefined;
    const height = splitRef.current?.getBoundingClientRect().height ?? 0;
    if (height <= SPLIT_SEPARATOR_PX) return pinnedVerticalSize.current ?? undefined;
    const next = Math.round(height);
    pinnedVerticalSize.current = next;
    setVerticalSize(next);
    return next;
  }

  function ratioAt(clientX: number, clientY: number): number {
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return effectiveRatio;
    const containerSize = axis === "horizontal" ? rect.width : rect.height;
    const available = Math.max(1, containerSize - SPLIT_SEPARATOR_PX);
    const offset = axis === "horizontal"
      ? clientX - rect.left
      : clientY - rect.top;
    const requested = (offset - SPLIT_SEPARATOR_PX / 2) / available;
    return clampSplitRatioForSize(
      requested,
      containerSize,
      minFirstPx,
      minSecondPx,
    );
  }

  function updateDrag(clientX: number, clientY: number): number {
    const next = ratioAt(clientX, clientY);
    lastDragRatio.current = next;
    setTransientRatio(next);
    return next;
  }

  function finishDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
    commit: boolean,
    useLastRatio = false,
  ): void {
    if (draggingPointer.current !== pointerId) return;
    const next = commit
      ? (useLastRatio ? lastDragRatio.current : updateDrag(clientX, clientY))
      : null;
    draggingPointer.current = null;
    lastDragRatio.current = null;
    setDragging(false);
    const separator = separatorRef.current;
    if (separator?.hasPointerCapture(pointerId)) {
      separator.releasePointerCapture(pointerId);
    }
    dragCleanup.current?.();
    dragCleanup.current = null;
    if (next !== null) onRatioChange?.(next, pinnedVerticalSize.current ?? undefined);
    setTransientRatio(null);
  }

  useEffect(() => () => {
    dragCleanup.current?.();
    dragCleanup.current = null;
    draggingPointer.current = null;
    lastDragRatio.current = null;
  }, []);

  function setFromKeyboard(next: number): void {
    const rect = splitRef.current?.getBoundingClientRect();
    const size = axis === "horizontal" ? rect?.width ?? 0 : rect?.height ?? 0;
    const verticalSize = axis === "vertical" ? pinVerticalHeight() : undefined;
    onRatioChange?.(clampSplitRatioForSize(
      next,
      size,
      minFirstPx,
      minSecondPx,
    ), verticalSize);
  }

  function resetSplit(): void {
    if (axis === "vertical") {
      pinnedVerticalSize.current = null;
      setVerticalSize(null);
    }
    onRatioReset?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const increment = event.shiftKey ? 0.1 : 0.02;
    if ((axis === "horizontal" && event.key === "ArrowLeft") || (axis === "vertical" && event.key === "ArrowUp")) {
      event.preventDefault();
      setFromKeyboard(effectiveRatio - increment);
    } else if ((axis === "horizontal" && event.key === "ArrowRight") || (axis === "vertical" && event.key === "ArrowDown")) {
      event.preventDefault();
      setFromKeyboard(effectiveRatio + increment);
    } else if (event.key === "Home") {
      event.preventDefault();
      setFromKeyboard(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFromKeyboard(1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetSplit();
    } else if (event.key === "Escape" && draggingPointer.current !== null) {
      event.preventDefault();
      finishDrag(draggingPointer.current, 0, 0, false);
    }
  }

  return (
    <div className="split-container" ref={containerRef}>
      <div
        className={`split split--${axis}${axis === "vertical" ? (verticalRatioSized ? " split--ratio-sized" : " split--content-sized") : ""}${enabled ? " split--resizable" : ""}${dragging ? " split--dragging" : ""}`}
        ref={splitRef}
        style={style}
      >
        <div className="split__pane split__pane--first" data-slot="first" id={firstId}>
          {first}
        </div>
        {enabled ? (
          <div
            className="split__separator"
            ref={separatorRef}
            role="separator"
            tabIndex={0}
            aria-controls={`${firstId} ${secondId}`}
            aria-label={`Resize ${label}`}
            aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
            aria-valuemin={10}
            aria-valuemax={90}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% first pane, ${100 - percent}% second pane`}
            title={`Drag to resize. Press Enter or double-click to reset to ${defaultPercent}%.`}
            onDoubleClick={resetSplit}
            onKeyDown={handleKeyDown}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              dragCleanup.current?.();
              pinVerticalHeight();
              draggingPointer.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              updateDrag(event.clientX, event.clientY);
              const pointerId = event.pointerId;
              const finishFromPointer = (finishEvent: globalThis.PointerEvent): void => {
                if (finishEvent.pointerId !== pointerId) return;
                finishDrag(pointerId, finishEvent.clientX, finishEvent.clientY, true);
              };
              const finishFromMouse = (finishEvent: MouseEvent): void => {
                if (finishEvent.button !== 0) return;
                finishDrag(pointerId, finishEvent.clientX, finishEvent.clientY, true);
              };
              const updateFromPointer = (moveEvent: globalThis.PointerEvent): void => {
                if (moveEvent.pointerId !== pointerId) return;
                moveEvent.preventDefault();
                updateDrag(moveEvent.clientX, moveEvent.clientY);
              };
              const cancelFromPointer = (cancelEvent: globalThis.PointerEvent): void => {
                if (cancelEvent.pointerId !== pointerId) return;
                finishDrag(pointerId, cancelEvent.clientX, cancelEvent.clientY, false);
              };
              const cancelFromBlur = (): void => finishDrag(pointerId, 0, 0, false);
              const cleanup = (): void => {
                window.removeEventListener("pointermove", updateFromPointer);
                window.removeEventListener("pointerup", finishFromPointer);
                window.removeEventListener("pointercancel", cancelFromPointer);
                window.removeEventListener("mouseup", finishFromMouse);
                window.removeEventListener("blur", cancelFromBlur);
              };
              dragCleanup.current = cleanup;
              window.addEventListener("pointermove", updateFromPointer, { passive: false });
              window.addEventListener("pointerup", finishFromPointer);
              window.addEventListener("pointercancel", cancelFromPointer);
              window.addEventListener("mouseup", finishFromMouse);
              window.addEventListener("blur", cancelFromBlur);
            }}
            onPointerUp={(event) => finishDrag(event.pointerId, event.clientX, event.clientY, true)}
            onPointerCancel={(event) => finishDrag(event.pointerId, event.clientX, event.clientY, false)}
            onLostPointerCapture={() => {
              const pointerId = draggingPointer.current;
              if (pointerId === null) return;
              // Keep the last valid position if the host drops capture before
              // dispatching pointerup, rather than snapping back or leaking a
              // stuck dragging state.
              finishDrag(pointerId, 0, 0, true, true);
            }}
          >
            <span className="split__separator-line" aria-hidden="true" />
          </div>
        ) : null}
        <div className="split__pane split__pane--second" data-slot="second" id={secondId}>
          {second}
        </div>
      </div>
    </div>
  );
}
