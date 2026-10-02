import { useLayoutEffect, useRef } from "react";

/**
 * A ref that holds the last committed value, for event handlers and stable
 * callbacks that must not close over a stale render. It is written in a layout
 * effect, never during render, so a discarded render cannot leak into it.
 * A handler may write ahead of the next commit (an optimistic update that a
 * following call must see); the next commit overwrites it.
 */
export function useLatestRef<T>(value: T): { current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
