import type { ComponentChildLayout, ResolvedComponentNode } from "../shared/contracts";
import { childNodes, layoutBranchKey, type LayoutBranch } from "./component-children";

export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;
export const DEFAULT_SPLIT_MIN_PX = 180;
export const MIN_SPLIT_MIN_PX = 80;
export const MAX_SPLIT_MIN_PX = 1_200;
export const SPLIT_SEPARATOR_PX = 12;

const MAX_SPLIT_RATIO_OVERRIDES = 2_000;
const SPLIT_RATIO_PRECISION = 1_000;

export interface SplitRatioOverride {
  ratio: number;
  defaultRatio: number;
}

export type SplitRatioOverrides = Record<string, SplitRatioOverride>;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeSplitRatio(value: unknown): number {
  const ratio = clamp(
    finiteNumber(value, DEFAULT_SPLIT_RATIO),
    MIN_SPLIT_RATIO,
    MAX_SPLIT_RATIO,
  );
  return Math.round(ratio * SPLIT_RATIO_PRECISION) / SPLIT_RATIO_PRECISION;
}

export function normalizeSplitMinPx(value: unknown): number {
  return Math.round(clamp(
    finiteNumber(value, DEFAULT_SPLIT_MIN_PX),
    MIN_SPLIT_MIN_PX,
    MAX_SPLIT_MIN_PX,
  ));
}

export function clampSplitRatioForSize(
  value: number,
  containerSize: number,
  minFirstPx: number,
  minSecondPx: number,
): number {
  const requested = normalizeSplitRatio(value);
  if (!Number.isFinite(containerSize) || containerSize <= SPLIT_SEPARATOR_PX) {
    return requested;
  }

  const available = containerSize - SPLIT_SEPARATOR_PX;
  const firstMinimum = normalizeSplitMinPx(minFirstPx);
  const secondMinimum = normalizeSplitMinPx(minSecondPx);
  if (firstMinimum + secondMinimum >= available) {
    // A compact or auto-sized branch cannot satisfy both pixel minima. Keep
    // the splitter usable and let the pane content/overflow handle the
    // shortage instead of locking the handle at one ratio.
    return requested;
  }

  const minimumRatio = Math.max(MIN_SPLIT_RATIO, firstMinimum / available);
  const maximumRatio = Math.min(MAX_SPLIT_RATIO, 1 - secondMinimum / available);
  return normalizeSplitRatio(clamp(requested, minimumRatio, maximumRatio));
}

export function splitRatioOverridesStorageKey(configPath: string): string {
  return `dash-bored:split-ratios:${configPath}`;
}

function isSplitRatioOverride(value: unknown): value is SplitRatioOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SplitRatioOverride>;
  return (
    typeof item.ratio === "number" &&
    Number.isFinite(item.ratio) &&
    item.ratio >= MIN_SPLIT_RATIO &&
    item.ratio <= MAX_SPLIT_RATIO &&
    typeof item.defaultRatio === "number" &&
    Number.isFinite(item.defaultRatio) &&
    item.defaultRatio >= MIN_SPLIT_RATIO &&
    item.defaultRatio <= MAX_SPLIT_RATIO
  );
}

export function parseSplitRatioOverrides(raw: string | null): SplitRatioOverrides {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([id, value]) => id.length > 0 && id.length <= 128 && isSplitRatioOverride(value))
        .slice(0, MAX_SPLIT_RATIO_OVERRIDES)
        .map(([id, value]) => [id, {
          ratio: normalizeSplitRatio(value.ratio),
          defaultRatio: normalizeSplitRatio(value.defaultRatio),
        }]),
    );
  } catch {
    return {};
  }
}

export function serializeSplitRatioOverrides(
  overrides: Readonly<SplitRatioOverrides>,
): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(overrides)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_SPLIT_RATIO_OVERRIDES),
  ));
}

export function splitRatioMatches(left: number, right: number): boolean {
  return normalizeSplitRatio(left) === normalizeSplitRatio(right);
}

export function effectiveSplitRatio(
  defaultRatio: number,
  override: SplitRatioOverride | undefined,
): number {
  const normalizedDefault = normalizeSplitRatio(defaultRatio);
  return override && splitRatioMatches(override.defaultRatio, normalizedDefault)
    ? normalizeSplitRatio(override.ratio)
    : normalizedDefault;
}

export function collectResizableSplitDefaults(
  root: ResolvedComponentNode,
): Map<string, number> {
  const defaults = new Map<string, number>();
  function visitLayout(
    nodeId: string,
    layout: ComponentChildLayout<ResolvedComponentNode>,
    path: LayoutBranch[] = [],
  ): void {
    if (layout.type === "child") return;
    if (layout.axis === "horizontal") {
      defaults.set(layoutBranchKey(nodeId, path), normalizeSplitRatio(layout.ratio));
    }
    visitLayout(nodeId, layout.first, [...path, "first"]);
    visitLayout(nodeId, layout.second, [...path, "second"]);
  }
  function visit(node: ResolvedComponentNode): void {
    if (node.children?.type === "tiled") {
      visitLayout(node.id, node.children.layout);
    }
    for (const child of childNodes(node)) visit(child);
  }
  visit(root);
  return defaults;
}

export function pruneSplitRatioOverrides(
  overrides: Readonly<SplitRatioOverrides>,
  root: ResolvedComponentNode,
): SplitRatioOverrides {
  const defaults = collectResizableSplitDefaults(root);
  return Object.fromEntries(
    Object.entries(overrides).filter(([id, override]) => {
      const defaultRatio = defaults.get(id);
      return defaultRatio !== undefined && splitRatioMatches(defaultRatio, override.defaultRatio);
    }),
  );
}
