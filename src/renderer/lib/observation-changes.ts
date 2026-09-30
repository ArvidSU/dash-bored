import { useEffect, useRef, useState } from "react";

/** How long a transient "just changed" highlight lasts; the text cue remains. */
export const CHANGE_FLASH_MS = 1200;

export type ObservedChange = { from: string; at: Date };

/** True for CHANGE_FLASH_MS after each new change time. */
function useFlash(at: Date | undefined): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!at) return;
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), CHANGE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [at]);
  return flashing;
}

/**
 * Track the last change of a displayed observation within this mount. The
 * first settled observation is the baseline, so nothing is marked on arrival.
 */
export function useObservationChange(value: string, settled: boolean): { change?: ObservedChange; flashing: boolean } {
  const previous = useRef<string | undefined>(undefined);
  const [change, setChange] = useState<ObservedChange | undefined>(undefined);
  useEffect(() => {
    if (!settled) return;
    const before = previous.current;
    previous.current = value;
    if (before === undefined || before === value) return;
    setChange({ from: before, at: new Date() });
  }, [settled, value]);
  return { change, flashing: useFlash(change?.at) };
}

export type ItemChangeKind = "new" | "changed";

/** Compare two observations keyed by stable ID; removed items are simply absent. */
export function diffObservedItems<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  fingerprint: (item: T) => string = (item) => JSON.stringify(item),
): Map<string, ItemChangeKind> {
  const before = new Map(previous.map((item) => [item.id, fingerprint(item)]));
  const changes = new Map<string, ItemChangeKind>();
  for (const item of next) {
    const prior = before.get(item.id);
    if (prior === undefined) changes.set(item.id, "new");
    else if (prior !== fingerprint(item)) changes.set(item.id, "changed");
  }
  return changes;
}

/**
 * Items that differed in the most recent observation that changed anything.
 * Identical polls keep the markers, so a glance after a quiet poll still shows
 * what moved; the next differing observation replaces them.
 */
export function useChangedItems<T extends { id: string }>(
  items: readonly T[] | undefined,
  enabled: boolean,
): { changes: ReadonlyMap<string, ItemChangeKind>; at?: Date; flashing: boolean } {
  const previous = useRef<readonly T[] | undefined>(undefined);
  const [state, setState] = useState<{ changes: ReadonlyMap<string, ItemChangeKind>; at?: Date }>({ changes: new Map() });
  useEffect(() => {
    if (!enabled || items === undefined) return;
    const before = previous.current;
    previous.current = items;
    if (before === undefined) return;
    const changes = diffObservedItems(before, items);
    const removed = before.some((item) => !items.some((candidate) => candidate.id === item.id));
    if (changes.size === 0 && !removed) return;
    setState({ changes, at: new Date() });
  }, [enabled, items]);
  const flashing = useFlash(state.changes.size ? state.at : undefined);
  return { ...(enabled ? state : { changes: new Map() }), flashing: enabled && flashing };
}
