import type {
  ComponentAction,
  ComponentActionConfirmation,
} from "../../shared/contracts";

const ACTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  keywords: string[];
  group: string;
  source?: string;
  enabled: boolean;
  disabledReason?: string;
  confirmation?: ComponentActionConfirmation;
  run(): void | Promise<void>;
}

export interface ComponentActionOwner {
  scope: string;
  nodeId: string;
  componentName: string;
}

interface RegisteredAction {
  ownerKey: string;
  token: symbol;
  action: PaletteAction;
}

type Listener = () => void;

function ownerKey(owner: Pick<ComponentActionOwner, "scope" | "nodeId">): string {
  return JSON.stringify([owner.scope, owner.nodeId]);
}

export function componentActionId(
  owner: Pick<ComponentActionOwner, "scope" | "nodeId">,
  localId: string,
): string {
  return ["component", owner.scope, owner.nodeId, localId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function validateComponentAction(action: ComponentAction): ComponentAction {
  if (!action || typeof action !== "object") {
    throw new Error("Component actions must be objects.");
  }
  if (typeof action.id !== "string" || !ACTION_ID_PATTERN.test(action.id)) {
    throw new Error(
      "Component action ids must start with an ASCII letter and contain only letters, digits, underscores, or hyphens.",
    );
  }
  if (typeof action.label !== "string" || action.label.trim() === "") {
    throw new Error("Component action labels must be non-empty strings.");
  }
  if (typeof action.run !== "function") {
    throw new Error("Component actions must provide a run function.");
  }
  if (action.enabled !== undefined && typeof action.enabled !== "boolean") {
    throw new Error("Component action enabled values must be booleans.");
  }
  if (
    action.keywords !== undefined &&
    (!Array.isArray(action.keywords) ||
      action.keywords.some(
        (keyword) => typeof keyword !== "string" || keyword.trim() === "",
      ))
  ) {
    throw new Error("Component action keywords must be non-empty strings.");
  }
  optionalText(action.description, "Component action descriptions");
  optionalText(action.disabledReason, "Component action disabled reasons");
  if (action.confirmation !== undefined) {
    if (!action.confirmation || typeof action.confirmation !== "object") {
      throw new Error("Component action confirmation must be an object.");
    }
    if (
      typeof action.confirmation.title !== "string" ||
      action.confirmation.title.trim() === ""
    ) {
      throw new Error("Confirmation titles must be non-empty strings.");
    }
    optionalText(action.confirmation.message, "Confirmation messages");
    optionalText(action.confirmation.confirmLabel, "Confirmation labels");
  }
  return action;
}

export class ActionRegistry {
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly listeners = new Set<Listener>();
  private snapshot: readonly PaletteAction[] = [];

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly PaletteAction[] => this.snapshot;

  get(id: string): PaletteAction | undefined {
    return this.actions.get(id)?.action;
  }

  register(owner: ComponentActionOwner, input: ComponentAction): () => void {
    const action = validateComponentAction(input);
    const id = componentActionId(owner, action.id);
    if (this.actions.has(id)) {
      throw new Error(
        `Component ${owner.componentName} registered duplicate action id ${action.id}.`,
      );
    }

    const token = Symbol(id);
    this.actions.set(id, {
      ownerKey: ownerKey(owner),
      token,
      action: {
        id,
        label: action.label.trim(),
        ...(action.description === undefined
          ? {}
          : { description: action.description.trim() }),
        keywords: (action.keywords ?? []).map((keyword) => keyword.trim()),
        group: `Component · ${owner.componentName}`,
        source: owner.nodeId,
        enabled: action.enabled !== false,
        ...(action.enabled === false
          ? {
              disabledReason:
                action.disabledReason?.trim() || "This action is unavailable.",
            }
          : {}),
        ...(action.confirmation === undefined
          ? {}
          : {
              confirmation: {
                title: action.confirmation.title.trim(),
                ...(action.confirmation.message === undefined
                  ? {}
                  : { message: action.confirmation.message.trim() }),
                ...(action.confirmation.confirmLabel === undefined
                  ? {}
                  : { confirmLabel: action.confirmation.confirmLabel.trim() }),
              },
            }),
        run: action.run,
      },
    });
    this.emit();

    return () => {
      const current = this.actions.get(id);
      if (current?.token !== token) return;
      this.actions.delete(id);
      this.emit();
    };
  }

  clearOwner(owner: Pick<ComponentActionOwner, "scope" | "nodeId">): void {
    const expectedOwner = ownerKey(owner);
    let changed = false;
    for (const [id, registered] of this.actions) {
      if (registered.ownerKey !== expectedOwner) continue;
      this.actions.delete(id);
      changed = true;
    }
    if (changed) this.emit();
  }

  clearScope(scope: string): void {
    let changed = false;
    for (const [id, registered] of this.actions) {
      const parsed = JSON.parse(registered.ownerKey) as [string, string];
      if (parsed[0] !== scope) continue;
      this.actions.delete(id);
      changed = true;
    }
    if (changed) this.emit();
  }

  clear(): void {
    if (this.actions.size === 0) return;
    this.actions.clear();
    this.emit();
  }

  private emit(): void {
    this.snapshot = [...this.actions.values()].map(({ action }) => action);
    for (const listener of this.listeners) listener();
  }
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let position = 0;
  let first = -1;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found === -1) return null;
    if (first === -1) first = found;
    gaps += found - position;
    position = found + 1;
  }
  return 60 + first + gaps;
}

function fieldScore(field: string, query: string): number | null {
  const value = normalize(field);
  if (!value) return null;
  if (value === query) return 0;
  if (value.startsWith(query)) return 5;
  const tokenIndex = value
    .split(/\s+/)
    .findIndex((token) => token.startsWith(query));
  if (tokenIndex !== -1) return 10 + tokenIndex;
  const substring = value.indexOf(query);
  if (substring !== -1) return 25 + substring;
  return subsequenceScore(value, query);
}

function actionScore(action: PaletteAction, query: string): number | null {
  if (!query) return 0;
  const fields = [
    action.label,
    action.description ?? "",
    ...action.keywords,
    action.group,
    action.source ?? "",
  ];
  let best: number | null = null;
  for (const field of fields) {
    const score = fieldScore(field, query);
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

export function rankActions(
  actions: readonly PaletteAction[],
  rawQuery: string,
  favoriteActionIds: ReadonlySet<string> = new Set(),
): PaletteAction[] {
  const query = normalize(rawQuery);
  const groupOrder = new Map<string, number>();
  for (const action of actions) {
    if (!groupOrder.has(action.group)) groupOrder.set(action.group, groupOrder.size);
  }

  return actions
    .map((action, index) => ({ action, index, score: actionScore(action, query) }))
    .filter(
      (item): item is { action: PaletteAction; index: number; score: number } =>
        item.score !== null,
    )
    .sort(
      (left, right) =>
        Number(favoriteActionIds.has(right.action.id)) -
          Number(favoriteActionIds.has(left.action.id)) ||
        (groupOrder.get(left.action.group) ?? 0) -
          (groupOrder.get(right.action.group) ?? 0) ||
        left.score - right.score ||
        left.index - right.index,
    )
    .map(({ action }) => action);
}

export type ActionRunResult =
  | { status: "completed" }
  | { status: "running" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: unknown };

export class ActionExecutor {
  private readonly resolve: (id: string) => PaletteAction | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly running = new Set<string>();
  private snapshot: ReadonlySet<string> = new Set();

  constructor(resolve: (id: string) => PaletteAction | undefined) {
    this.resolve = resolve;
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ReadonlySet<string> => this.snapshot;

  async run(id: string): Promise<ActionRunResult> {
    const action = this.resolve(id);
    if (!action) {
      return {
        status: "unavailable",
        reason: "This action is no longer available.",
      };
    }
    if (!action.enabled) {
      return {
        status: "unavailable",
        reason: action.disabledReason ?? "This action is unavailable.",
      };
    }
    if (this.running.has(id)) return { status: "running" };

    this.running.add(id);
    this.emit();
    try {
      await action.run();
      return { status: "completed" };
    } catch (error) {
      return { status: "failed", error };
    } finally {
      this.running.delete(id);
      this.emit();
    }
  }

  private emit(): void {
    this.snapshot = new Set(this.running);
    for (const listener of this.listeners) listener();
  }
}
