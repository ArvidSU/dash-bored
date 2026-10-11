import type { ComponentActionSelections } from "../../shared/contracts";

/** One palette run the history can replay: the action and the options chosen for it. */
export interface PaletteRecent {
  actionId: string;
  selections?: ComponentActionSelections;
}

/** Runs remembered per dashboard; searches reach older runs than the unsearched list shows. */
export const PALETTE_RECENT_HISTORY_LIMIT = 25;

type RecentsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const EMPTY_RECENTS: readonly PaletteRecent[] = [];

export function paletteRecentsStorageKey(configPath: string): string {
  return `dash-bored:palette-recents:${configPath}`;
}

function normalizeSelections(value: unknown): ComponentActionSelections | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeRecent(value: unknown): PaletteRecent | null {
  if (!value || typeof value !== "object") return null;
  const { actionId, selections } = value as { actionId?: unknown; selections?: unknown };
  if (typeof actionId !== "string" || actionId === "") return null;
  const normalized = normalizeSelections(selections);
  return normalized ? { actionId, selections: normalized } : { actionId };
}

function sameRecent(left: PaletteRecent, right: PaletteRecent): boolean {
  if (left.actionId !== right.actionId) return false;
  const leftEntries = Object.entries(left.selections ?? {});
  return leftEntries.length === Object.keys(right.selections ?? {}).length
    && leftEntries.every(([choiceId, value]) => right.selections?.[choiceId] === value);
}

/** Put a run first, dropping an earlier identical run and anything past the history limit. */
export function addPaletteRecent(recents: readonly PaletteRecent[], recent: PaletteRecent): PaletteRecent[] {
  const normalized = normalizeRecent(recent);
  if (!normalized) return [...recents];
  return [normalized, ...recents.filter((candidate) => !sameRecent(candidate, normalized))]
    .slice(0, PALETTE_RECENT_HISTORY_LIMIT);
}

export function parsePaletteRecents(raw: string | null): PaletteRecent[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.reduceRight<PaletteRecent[]>((recents, item) => {
      const recent = normalizeRecent(item);
      return recent ? addPaletteRecent(recents, recent) : recents;
    }, []);
  } catch {
    return [];
  }
}

function browserStorage(): RecentsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Recently run palette actions per dashboard config path. Action IDs and
 * option values name one dashboard's nodes, so each dashboard keeps its own
 * history; without a dashboard nothing is recorded.
 */
export class PaletteRecentsStore {
  private readonly entries = new Map<string, readonly PaletteRecent[]>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly getStorage: () => RecentsStorage | null = browserStorage) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(path: string | null): readonly PaletteRecent[] {
    if (!path) return EMPTY_RECENTS;
    let recents = this.entries.get(path);
    if (!recents) {
      let raw: string | null = null;
      try { raw = this.getStorage()?.getItem(paletteRecentsStorageKey(path)) ?? null; } catch { /* Start empty. */ }
      recents = parsePaletteRecents(raw);
      this.entries.set(path, recents);
    }
    return recents;
  }

  record(path: string | null, recent: PaletteRecent): void {
    if (!path) return;
    const recents = addPaletteRecent(this.get(path), recent);
    this.entries.set(path, recents);
    try {
      this.getStorage()?.setItem(paletteRecentsStorageKey(path), JSON.stringify(recents));
    } catch { /* Keep the renderer history for this session. */ }
    this.notify();
  }

  forget(path: string): void {
    this.entries.delete(path);
    try { this.getStorage()?.removeItem(paletteRecentsStorageKey(path)); } catch { /* Already unreadable. */ }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const paletteRecentsStore = new PaletteRecentsStore();
