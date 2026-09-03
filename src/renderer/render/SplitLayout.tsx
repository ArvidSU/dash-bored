import { useId, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  ReactNode,
} from "react";
import {
  clampSplitRatioForSize,
  normalizeSplitRatio,
  SPLIT_SEPARATOR_PX,
} from "./split-layout";
import { usePointerSession } from "../lib/pointer-session";

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
  onRatioChange?: (ratio: number) => void;
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
  onRatioChange,
  onRatioReset,
}: SplitLayoutProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const lastDragRatio = useRef<number | null>(null);
  const pointerSession = usePointerSession();
  const [transientRatio, setTransientRatio] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const instanceId = useId().replaceAll(":", "");
  const firstId = `${instanceId}-first`;
  const secondId = `${instanceId}-second`;
  const effectiveRatio = normalizeSplitRatio(transientRatio ?? ratio);
  const enabled = axis === "horizontal" && resizable && onRatioChange !== undefined;
  const percent = Math.round(effectiveRatio * 100);
  const defaultPercent = Math.round(normalizeSplitRatio(defaultRatio) * 100);
  const style = {
    "--split-first-size": `${effectiveRatio * 100}fr`,
    "--split-second-size": `${(1 - effectiveRatio) * 100}fr`,
    "--split-separator-size": `${SPLIT_SEPARATOR_PX}px`,
  } as CSSProperties;

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
    if (next !== null) onRatioChange?.(next);
    setTransientRatio(null);
  }

  function setFromKeyboard(next: number): void {
    const rect = splitRef.current?.getBoundingClientRect();
    const size = rect?.width ?? 0;
    onRatioChange?.(clampSplitRatioForSize(
      next,
      size,
      minFirstPx,
      minSecondPx,
    ));
  }

  function resetSplit(): void {
    onRatioReset?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const increment = event.shiftKey ? 0.1 : 0.02;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setFromKeyboard(effectiveRatio - increment);
    } else if (event.key === "ArrowRight") {
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
        className={`split split--${axis}${enabled ? " split--resizable" : ""}${dragging ? " split--dragging" : ""}`}
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
              draggingPointer.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              updateDrag(event.clientX, event.clientY);
              pointerSession.start({
                pointerId: event.pointerId,
                mouseUpFallback: true,
                onMove: (moveEvent) => {
                  moveEvent.preventDefault();
                  updateDrag(moveEvent.clientX, moveEvent.clientY);
                },
                onFinish: (finishEvent, reason) => {
                  const commit = reason === "up" || reason === "lost";
                  finishDrag(
                    event.pointerId,
                    finishEvent?.clientX ?? 0,
                    finishEvent?.clientY ?? 0,
                    commit,
                    reason === "lost",
                  );
                },
              });
            }}
            onPointerUp={(event) => pointerSession.finish(event.pointerId, event.nativeEvent)}
            onPointerCancel={(event) => pointerSession.finish(event.pointerId, event.nativeEvent, "cancel")}
            onLostPointerCapture={() => {
              const pointerId = draggingPointer.current;
              if (pointerId === null) return;
              // Keep the last valid position if the host drops capture before
              // dispatching pointerup, rather than snapping back or leaking a
              // stuck dragging state.
              pointerSession.finish(pointerId, null, "lost");
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
