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
  /** Declared by a manifest but not registered by mounted component code; listed only in searches. */
  declaredOnly?: boolean;
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

export interface ActionProviderSnapshot {
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
      candidate.declaredOnly,
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

/** Prefix a verb unless the label already starts with it ("Run QA", not "Run Run QA"). */
export function verbLabel(verb: string, label: string): string {
  return normalize(label).split(" ")[0] === normalize(verb) ? label : `${verb} ${label}`;
}

/**
 * How permissive matching is for a field. Visible labels allow substrings and
 * fuzzy abbreviations; author keywords allow substrings; descriptive metadata
 * (descriptions, shell commands, paths, groups) only matches whole words or
 * word prefixes so incidental letters in long text never surface a result.
 */
type MatchMode = "label" | "keyword" | "metadata";

interface SearchField {
  value: string;
  penalty: number;
  mode: MatchMode;
}

function subsequenceScore(haystack: string, needle: string): number | null {
  if (needle.length < 2) return null;
  let best: number | null = null;
  // Abbreviations start at a word boundary and stay reasonably compact.
  for (let start = haystack.indexOf(needle[0]!); start !== -1; start = haystack.indexOf(needle[0]!, start + 1)) {
    if (start > 0 && haystack[start - 1] !== " ") continue;
    let position = start + 1;
    let gaps = 0;
    for (const character of needle.slice(1)) {
      const found = haystack.indexOf(character, position);
      if (found === -1) return best;
      gaps += found - position;
      position = found + 1;
    }
    if (gaps > needle.length * 3) continue;
    const score = 60 + start + gaps;
    if (best === null || score < best) best = score;
  }
  return best;
}

function fieldScore(value: string, query: string, mode: MatchMode): number | null {
  if (!value) return null;
  if (value === query) return 0;
  if (value.startsWith(query)) return 5;
  const tokens = value.split(" ");
  const tokenIndex = tokens.findIndex((token) => token.startsWith(query));
  if (tokenIndex !== -1) return 10 + tokenIndex;
  if (mode === "metadata") return null;
  if (mode === "label" && query.length > 1 && !query.includes(" ")) {
    // Word initials: "sdt" finds "Set dashboard theme".
    const initials = tokens.map((token) => token[0]).join("");
    const initialsIndex = initials.indexOf(query);
    if (initialsIndex !== -1) return 20 + initialsIndex;
  }
  const substring = value.indexOf(query);
  if (substring !== -1) return 25 + substring;
  return mode === "label" ? subsequenceScore(value, query) : null;
}

function searchableFieldsScore(fields: readonly SearchField[], query: string): number | null {
  if (!query) return 0;
  const normalizedFields = fields.map((field) => ({ ...field, value: normalize(field.value) }));
  const bestFieldScore = (term: string): number | null => {
    let best: number | null = null;
    for (const { value, penalty, mode } of normalizedFields) {
      const score = fieldScore(value, term, mode);
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

function actionScore(action: PaletteAction, query: string): number | null {
  // Visible names should beat incidental description, group, or path matches.
  return searchableFieldsScore([
    { value: action.label, penalty: 0, mode: "label" },
    ...action.keywords.map((value) => ({ value, penalty: 15, mode: "keyword" as const })),
    { value: action.description ?? "", penalty: 30, mode: "metadata" },
    { value: action.group, penalty: 40, mode: "metadata" },
    { value: action.source ?? "", penalty: 40, mode: "metadata" },
  ], query);
}

function optionScore(option: ComponentActionOption, query: string): number | null {
  return searchableFieldsScore([
    { value: option.label, penalty: 0, mode: "label" },
    { value: option.value, penalty: 15, mode: "keyword" },
    { value: option.description ?? "", penalty: 30, mode: "metadata" },
  ], query);
}

/** Rank a choice's options with the palette's exact, prefix, word, and fuzzy label matching. */
export function rankActionChoiceOptions(
  options: readonly ComponentActionOption[],
  rawQuery: string,
): ComponentActionOption[] {
  const query = normalize(rawQuery);
  return options
    .map((option, index) => ({ option, index, score: optionScore(option, query) }))
    .filter((item): item is { option: ComponentActionOption; index: number; score: number } => item.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ option }) => option);
}

interface ScoredAction {
  action: PaletteAction;
  index: number;
  score: number;
}

function scoreActions(
  actions: readonly PaletteAction[],
  query: string,
  includeSubActions: boolean,
): ScoredAction[] {
  return actions
    .filter((action) => includeSubActions || !action.parentActionId)
    .map((action, index) => {
      const score = actionScore(action, query);
      // While searching, unavailable actions sit below available matches of similar relevance.
      return { action, index, score: score === null ? null : score + (query && !action.enabled ? 20 : 0) };
    })
    .filter((item): item is ScoredAction => item.score !== null);
}

function groupOrderOf(actions: readonly PaletteAction[]): Map<string, number> {
  const groupOrder = new Map<string, number>();
  for (const action of actions) {
    if (!groupOrder.has(action.group)) groupOrder.set(action.group, groupOrder.size);
  }
  return groupOrder;
}

export function rankActions(
  actions: readonly PaletteAction[],
  rawQuery: string,
  favoriteActionIds: ReadonlySet<string> = new Set(),
  includeSubActions = false,
): PaletteAction[] {
  const query = normalize(rawQuery);
  const groupOrder = groupOrderOf(actions);
  return scoreActions(actions, query, includeSubActions)
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

/** A command-palette row: an action, or one option of an action's first choice. */
export type PaletteEntry =
  | {
      kind: "action";
      key: string;
      action: PaletteAction;
      /** Options of this action's first choice that match the search; the chooser opens filtered. */
      optionMatches?: number;
    }
  | {
      kind: "option";
      key: string;
      action: PaletteAction;
      choice: ComponentActionChoice;
      option: ComponentActionOption;
    };

/** Option rows shown per chooser before the chooser itself stands in for the rest. */
export const PALETTE_OPTION_RESULT_LIMIT = 3;

/** Present an action once when several providers describe the same control. */
function dedupePaletteActions(actions: readonly PaletteAction[]): PaletteAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (!action.source) return true;
    const key = `${normalize(action.label)}\u0000${action.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstChoiceOptions(action: PaletteAction): { options: readonly ComponentActionOption[] } | { error: string } | null {
  const choice = action.choices?.[0];
  if (!choice) return null;
  try {
    return { options: resolveActionChoiceOptions(choice, {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "This action has no usable options." };
  }
}

/**
 * Rank palette rows. Sub-actions stay out of the list; instead a search also
 * matches the options of each chooser, so a component, dashboard, or panel can
 * be reached by name without opening its chooser first.
 */
export function rankPaletteEntries(
  actions: readonly PaletteAction[],
  rawQuery: string,
  favoriteActionIds: ReadonlySet<string> = new Set(),
): PaletteEntry[] {
  const query = normalize(rawQuery);
  // Placeholders for unmounted components stay searchable without crowding the full list.
  const listed = query ? actions : actions.filter((action) => !action.declaredOnly);
  const unique = dedupePaletteActions(listed).map((action): PaletteAction => {
    const resolved = action.enabled ? firstChoiceOptions(action) : null;
    return resolved && "error" in resolved
      ? { ...action, enabled: false, disabledReason: "No options are available right now." }
      : action;
  });
  const groupOrder = groupOrderOf(unique);
  type Scored = { entry: PaletteEntry; score: number; index: number; order: number; favorite: boolean };
  const scored: Scored[] = scoreActions(unique, query, false).map(({ action, index, score }) => ({
    entry: { kind: "action", key: action.id, action },
    score,
    index,
    order: 0,
    favorite: favoriteActionIds.has(action.id),
  }));
  if (query) {
    unique.forEach((action, index) => {
      const choice = action.choices?.[0];
      const resolved = firstChoiceOptions(action);
      if (action.parentActionId || !choice || !resolved || "error" in resolved) return;
      const matches = resolved.options
        .map((option, position) => {
          // Options match by name or stable value; their descriptions are context, not search targets.
          const score = searchableFieldsScore([
            { value: option.label, penalty: 0, mode: "keyword" },
            { value: option.value, penalty: 10, mode: "metadata" },
          ], query);
          return { option, position, score: score === null ? null : score + 5 + (action.enabled ? 0 : 20) };
        })
        .filter((item): item is { option: ComponentActionOption; position: number; score: number } => item.score !== null)
        .sort((left, right) => left.score - right.score || left.position - right.position);
      if (matches.length === 0) return;
      const shown = matches.slice(0, PALETTE_OPTION_RESULT_LIMIT);
      shown.forEach(({ option, score }, order) => scored.push({
        entry: { kind: "option", key: `${action.id}\u0000${option.value}`, action, choice, option },
        score,
        index,
        order: order + 1,
        favorite: false,
      }));
      if (matches.length <= PALETTE_OPTION_RESULT_LIMIT) return;
      const own = scored.find((item) => item.entry.kind === "action" && item.entry.action.id === action.id);
      if (own) return;
      // The chooser follows the options it summarizes and opens filtered to the rest.
      scored.push({
        entry: { kind: "action", key: action.id, action, optionMatches: matches.length },
        score: shown.at(-1)!.score,
        index,
        order: shown.length + 1,
        favorite: favoriteActionIds.has(action.id),
      });
    });
  }
  return scored
    .sort(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) ||
        left.score - right.score ||
        (groupOrder.get(left.entry.action.group) ?? 0) - (groupOrder.get(right.entry.action.group) ?? 0) ||
        left.index - right.index ||
        left.order - right.order,
    )
    .map(({ entry }) => entry);
}

export type ActionRunResult =
  | { status: "completed" }
  | { status: "running" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: unknown };
