import type {
  ComponentAction,
  ComponentActionConfirmation,
  ComponentActionChoice,
  ComponentActionOption,
  ComponentActionSelections,
  ActionInvocationState,
  Diagnostic,
  ProcessSnapshot,
  ResolvedComponentAction,
} from "../../shared/contracts";
import { componentActionReference } from "../../shared/action-reference";
import { agentActionRefusal, type AgentActionDescriptor } from "../../shared/agent-control";

const ACTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface PaletteAction {
  id: string;
  /** Stable author-facing alias, when the runtime id is scoped to a mount. */
  reference?: string;
  /** Listed through this parent action instead of as a top-level palette result. */
  parentActionId?: string;
  label: string;
  description?: string;
  keywords: string[];
  group: string;
  source?: string;
  enabled: boolean;
  active?: boolean;
  disabledReason?: string;
  confirmation?: ComponentActionConfirmation;
  choices?: readonly ComponentActionChoice[];
  process?: ProcessSnapshot;
  invocationOutcome?: "started" | "completed" | "prepared";
  run(selections?: ComponentActionSelections, args?: Record<string, unknown>, callerNodeId?: string): void | Promise<void>;
}

/** Serializable view of a palette action for the agent-control channel. */
export function describeAgentAction(action: PaletteAction): AgentActionDescriptor {
  const refusal = agentActionRefusal(action);
  return {
    id: action.id,
    // Agents pass this back to `app run`; ids are references too.
    reference: action.reference ?? action.id,
    label: action.label,
    ...(action.description ? { description: action.description } : {}),
    group: action.group,
    ...(action.source ? { source: action.source } : {}),
    enabled: action.enabled,
    ...(action.active !== undefined ? { active: action.active } : {}),
    ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
    ...(action.choices?.length ? { choices: action.choices } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

export interface ComponentActionOwner {
  scope: string;
  nodeId: string;
  componentName: string;
  /** Undefined keeps legacy dynamic registration; an empty list opts in and rejects every ID. */
  declaredActionIds?: readonly string[];
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

function validateChoiceOption(option: ComponentActionOption, choiceId: string): void {
  if (!option || typeof option !== "object") {
    throw new Error(`Options for component action choice ${choiceId} must be objects.`);
  }
  if (typeof option.value !== "string" || option.value.trim() === "") {
    throw new Error(`Options for component action choice ${choiceId} need non-empty values.`);
  }
  if (typeof option.label !== "string" || option.label.trim() === "") {
    throw new Error(`Options for component action choice ${choiceId} need non-empty labels.`);
  }
  optionalText(option.description, `Descriptions for component action choice ${choiceId}`);
}

function validateChoices(choices: ComponentAction["choices"]): void {
  if (choices === undefined) return;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("Component action choices must be a non-empty array.");
  }
  const ids = new Set<string>();
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") {
      throw new Error("Component action choices must be objects.");
    }
    if (typeof choice.id !== "string" || !ACTION_ID_PATTERN.test(choice.id)) {
      throw new Error("Component action choice ids must start with an ASCII letter and contain only letters, digits, underscores, or hyphens.");
    }
    if (ids.has(choice.id)) throw new Error(`Component action choices contain duplicate id ${choice.id}.`);
    ids.add(choice.id);
    if (typeof choice.label !== "string" || choice.label.trim() === "") {
      throw new Error(`Component action choice ${choice.id} labels must be non-empty.`);
    }
    if (typeof choice.options !== "function" && !Array.isArray(choice.options)) {
      throw new Error(`Component action choice ${choice.id} options must be an array or resolver.`);
    }
    if (Array.isArray(choice.options)) {
      if (choice.options.length === 0) throw new Error(`Component action choice ${choice.id} options must be non-empty.`);
      (choice.options as readonly ComponentActionOption[]).forEach((option) => validateChoiceOption(option, choice.id));
    }
  }
}

export function resolveActionChoiceOptions(
  choice: ComponentActionChoice,
  selections: ComponentActionSelections,
): readonly ComponentActionOption[] {
  const options = typeof choice.options === "function" ? choice.options(selections) : choice.options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`Component action choice ${choice.id} resolved no options.`);
  }
  options.forEach((option) => validateChoiceOption(option, choice.id));
  return options;
}

export function matchActionChoiceSelections(
  choices: readonly ComponentActionChoice[],
  args: Readonly<Record<string, unknown>>,
): ComponentActionSelections {
  let matched: ComponentActionSelections = {};
  for (const choice of choices) {
    const value = args[choice.id];
    if (typeof value !== "string") continue;
    try {
      if (resolveActionChoiceOptions(choice, matched).some((option) => option.value === value)) {
        matched = { ...matched, [choice.id]: value };
      }
    } catch {
      // Choices with unresolved dependent options remain interactive in the palette.
    }
  }
  return matched;
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
  validateChoices(action.choices);
  if (action.invocationOutcome !== undefined && !["started", "completed", "prepared"].includes(action.invocationOutcome)) {
    throw new Error("Component action invocation outcome is invalid.");
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

export interface ActionStoreSnapshot {
  actions: readonly PaletteAction[];
  componentActions: readonly PaletteAction[];
  runningActionIds: ReadonlySet<string>;
  invocationStates: ReadonlyMap<string, ActionInvocationState>;
  diagnostics: readonly Diagnostic[];
}

interface ActionProviderSnapshot {
  id: string;
  actions: readonly PaletteAction[];
}

function sameActionPresentation(left: readonly PaletteAction[], right: readonly PaletteAction[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((action, index) => {
    const other = right[index];
    if (!other) return false;
    const fields = (candidate: PaletteAction) => [
      candidate.id,
      candidate.reference,
      candidate.parentActionId,
      candidate.label,
      candidate.description,
      candidate.keywords,
      candidate.group,
      candidate.source,
      candidate.enabled,
      candidate.active,
      candidate.disabledReason,
      candidate.confirmation,
      candidate.choices?.map((choice) => ({
        id: choice.id,
        label: choice.label,
        options: Array.isArray(choice.options) ? choice.options : "dynamic",
      })),
      candidate.process,
      candidate.invocationOutcome,
    ];
    return JSON.stringify(fields(action)) === JSON.stringify(fields(other));
  });
}

export class ActionStore {
  private readonly componentActions = new Map<string, RegisteredAction>();
  private providers: ActionProviderSnapshot[] = [];
  private readonly actionIndex = new Map<string, PaletteAction>();
  private readonly listeners = new Set<Listener>();
  private readonly registrationDiagnostics = new Map<string, Diagnostic>();
  private readonly running = new Set<string>();
  private readonly invocationStates = new Map<string, ActionInvocationState>();
  private runningSnapshot: ReadonlySet<string> = new Set();
  private state: ActionStoreSnapshot = {
    actions: [],
    componentActions: [],
    runningActionIds: this.runningSnapshot,
    invocationStates: new Map(),
    diagnostics: [],
  };

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ActionStoreSnapshot => this.state;
  readonly getDiagnostics = (): readonly Diagnostic[] => this.state.diagnostics;

  get(id: string): PaletteAction | undefined {
    return this.actionIndex.get(id);
  }

  getInvocationState(invocationKey: string): ActionInvocationState | undefined {
    return this.invocationStates.get(invocationKey);
  }

  /** Replace provider output in order; id/reference collisions keep the last provider. */
  replaceProviders(providers: readonly ActionProviderSnapshot[]): void {
    const presentationChanged = providers.length !== this.providers.length
      || providers.some((provider, index) => {
        const current = this.providers[index];
        return !current || current.id !== provider.id || !sameActionPresentation(current.actions, provider.actions);
      });
    this.providers = providers.map((provider) => ({ ...provider, actions: [...provider.actions] }));
    this.reindex();
    if (presentationChanged) this.emit();
  }

  getIndexedActions(): readonly PaletteAction[] {
    return [...new Set(this.actionIndex.values())];
  }

  resolve(reference: string, invocationKey?: string): ResolvedComponentAction {
    const action = this.get(reference);
    const resolvedInvocationKey = invocationKey ?? action?.id ?? reference;
    if (!action) return {
      id: reference,
      label: "Unavailable action",
      enabled: false,
      disabledReason: "This action is not available in the current view.",
      running: false,
      active: false,
      requiresInteraction: false,
      ...(this.getInvocationState(resolvedInvocationKey) ? { invocation: this.getInvocationState(resolvedInvocationKey) } : {}),
    };
    return {
      id: action.id,
      label: action.label,
      enabled: action.enabled,
      ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
      running: this.running.has(action.id),
      active: action.active === true,
      requiresInteraction: Boolean(action.choices?.length || action.confirmation),
      ...(action.process ? { process: action.process } : {}),
      ...(this.getInvocationState(resolvedInvocationKey) ? { invocation: this.getInvocationState(resolvedInvocationKey) } : {}),
    };
  }

  async run(
    id: string,
    selections: ComponentActionSelections = {},
    args: Record<string, unknown> = {},
    callerNodeId?: string,
    invocationKey = id,
  ): Promise<ActionRunResult> {
    const action = this.get(id);
    if (!action) return { status: "unavailable", reason: "This action is no longer available." };
    if (!action.enabled) return { status: "unavailable", reason: action.disabledReason ?? "This action is unavailable." };
    const canonicalId = action.id;
    if (this.running.has(canonicalId)) return { status: "running" };

    const startedAt = new Date().toISOString();
    this.setInvocation(invocationKey, { status: "running", startedAt });
    this.running.add(canonicalId);
    this.emit();
    try {
      await action.run(selections, args, callerNodeId);
      const outcome = id === "agent:prompt" ? "prepared" : action.invocationOutcome ?? "completed";
      this.setInvocation(invocationKey, {
        status: "completed",
        outcome,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(outcome === "prepared" ? { message: "Prompt ready for review." } : outcome === "started" ? { message: "Process start requested." } : {}),
      });
      return { status: "completed" };
    } catch (error) {
      this.setInvocation(invocationKey, {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      return { status: "failed", error };
    } finally {
      this.running.delete(canonicalId);
      this.emit();
    }
  }

  register(owner: ComponentActionOwner, input: ComponentAction): () => void {
    const action = validateComponentAction(input);
    if (owner.declaredActionIds !== undefined && !owner.declaredActionIds.includes(action.id)) {
      const key = `${ownerKey(owner)}:${action.id}`;
      this.registrationDiagnostics.set(key, {
        severity: "error",
        code: "COMPONENT_ACTION_UNDECLARED",
        message: `${owner.componentName} registered action ${action.id}, which is not declared in its manifest.`,
        path: owner.nodeId,
      });
      this.emit();
      return () => undefined;
    }
    this.registrationDiagnostics.delete(`${ownerKey(owner)}:${action.id}`);
    const id = componentActionId(owner, action.id);
    if (this.componentActions.has(id)) {
      throw new Error(
        `Component ${owner.componentName} registered duplicate action id ${action.id}.`,
      );
    }

    const token = Symbol(id);
    this.componentActions.set(id, {
      ownerKey: ownerKey(owner),
      token,
      action: {
        id,
        reference: componentActionReference(owner.nodeId, action.id),
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
        ...(action.choices === undefined ? {} : { choices: action.choices }),
        ...(action.invocationOutcome === undefined ? {} : { invocationOutcome: action.invocationOutcome }),
        ...(action.process === undefined ? {} : { process: action.process }),
        run: action.run,
      },
    });
    this.emit();

    return () => {
      const current = this.componentActions.get(id);
      if (current?.token !== token) return;
      this.componentActions.delete(id);
      this.emit();
    };
  }

  clearOwner(owner: Pick<ComponentActionOwner, "scope" | "nodeId">): void {
    const expectedOwner = ownerKey(owner);
    let changed = false;
    for (const [id, registered] of this.componentActions) {
      if (registered.ownerKey !== expectedOwner) continue;
      this.componentActions.delete(id);
      changed = true;
    }
    const diagnosticPrefix = `${expectedOwner}:`;
    for (const key of this.registrationDiagnostics.keys()) {
      if (!key.startsWith(diagnosticPrefix)) continue;
      this.registrationDiagnostics.delete(key);
      changed = true;
    }
    if (changed) this.emit();
  }

  clearScope(scope: string): void {
    let changed = false;
    for (const [id, registered] of this.componentActions) {
      const parsed = JSON.parse(registered.ownerKey) as [string, string];
      if (parsed[0] !== scope) continue;
      this.componentActions.delete(id);
      changed = true;
    }
    for (const key of this.registrationDiagnostics.keys()) {
      const owner = JSON.parse(key.slice(0, key.lastIndexOf(":"))) as [string, string];
      if (owner[0] !== scope) continue;
      this.registrationDiagnostics.delete(key);
      changed = true;
    }
    if (changed) this.emit();
  }

  clear(): void {
    if (this.componentActions.size === 0 && this.registrationDiagnostics.size === 0) return;
    this.componentActions.clear();
    this.registrationDiagnostics.clear();
    this.emit();
  }

  private reindex(): void {
    this.actionIndex.clear();
    const all = [
      ...this.providers.flatMap(({ actions }) => actions),
      ...[...this.componentActions.values()].map(({ action }) => action),
    ];
    for (const action of all) {
      this.actionIndex.set(action.id, action);
      if (action.reference) this.actionIndex.set(action.reference, action);
    }
  }

  private setInvocation(key: string, value: ActionInvocationState): void {
    this.invocationStates.delete(key);
    this.invocationStates.set(key, value);
    while (this.invocationStates.size > 200) {
      const oldest = this.invocationStates.keys().next().value;
      if (oldest === undefined) break;
      this.invocationStates.delete(oldest);
    }
  }

  private emit(): void {
    this.reindex();
    const componentActions = [...this.componentActions.values()].map(({ action }) => action);
    this.runningSnapshot = new Set(this.running);
    this.state = {
      actions: [
        ...this.providers.flatMap(({ actions }) => actions),
        ...componentActions,
      ],
      componentActions,
      runningActionIds: this.runningSnapshot,
      invocationStates: new Map(this.invocationStates),
      diagnostics: [...this.registrationDiagnostics.values()],
    };
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
  const value = field;
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
  // Visible names should beat incidental description, group, or path matches.
  const fields = [
    { value: action.label, penalty: 0 },
    ...action.keywords.map((value) => ({ value, penalty: 15 })),
    { value: action.description ?? "", penalty: 30 },
    { value: action.group, penalty: 40 },
    { value: action.source ?? "", penalty: 40 },
  ].map(({ value, penalty }) => ({ value: normalize(value), penalty }));
  const bestFieldScore = (term: string): number | null => {
    let best: number | null = null;
    for (const { value, penalty } of fields) {
      const score = fieldScore(value, term);
      if (score !== null && (best === null || score + penalty < best)) {
        best = score + penalty;
      }
    }
    return best;
  };
  let best = bestFieldScore(query);
  const terms = query.split(" ");
  if (terms.length > 1) {
    // Require every term, but allow reordered words and matches across fields.
    const scores = terms.map(bestFieldScore);
    if (scores.every((score): score is number => score !== null)) {
      const tokenScore = 15 + scores.reduce((sum, score) => sum + score, 0) / terms.length;
      best = best === null ? tokenScore : Math.min(best, tokenScore);
    }
  }
  return best;
}

export function rankActions(
  actions: readonly PaletteAction[],
  rawQuery: string,
  favoriteActionIds: ReadonlySet<string> = new Set(),
  includeSubActions = false,
): PaletteAction[] {
  const query = normalize(rawQuery);
  const groupOrder = new Map<string, number>();
  for (const action of actions) {
    if (!groupOrder.has(action.group)) groupOrder.set(action.group, groupOrder.size);
  }

  return actions
    .filter((action) => includeSubActions || !action.parentActionId)
    .map((action, index) => ({ action, index, score: actionScore(action, query) }))
    .filter(
      (item): item is { action: PaletteAction; index: number; score: number } =>
        item.score !== null,
    )
    .sort(
      (left, right) =>
        Number(favoriteActionIds.has(right.action.id)) -
          Number(favoriteActionIds.has(left.action.id)) ||
        left.score - right.score ||
        (groupOrder.get(left.action.group) ?? 0) -
          (groupOrder.get(right.action.group) ?? 0) ||
        left.index - right.index,
    )
    .map(({ action }) => action);
}

export type ActionRunResult =
  | { status: "completed" }
  | { status: "running" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: unknown };
