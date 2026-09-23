export interface DashboardListItem extends Record<string, unknown> {
  id: string;
  title: string;
  detail?: string;
  tags?: string[];
  state?: string;
  done?: boolean;
}

export interface ListShapeDiagnostic {
  index?: number;
  message: string;
}

export interface ListItemAction {
  name: string;
  action: { run: string; with: Record<string, unknown> };
}

export interface ResolvedListItemAction {
  invocation?: ListItemAction["action"];
  error?: string;
}

const ITEM_TEMPLATE = /^\$\{item\.([A-Za-z][A-Za-z0-9_-]*)\}$/;

export function parseListItemActions(value: unknown): {
  actions: ListItemAction[];
  diagnostics: string[];
} {
  if (value === undefined) return { actions: [], diagnostics: [] };
  if (!Array.isArray(value)) return { actions: [], diagnostics: ["itemActions must be an array."] };
  const actions: ListItemAction[] = [];
  const diagnostics: string[] = [];
  const names = new Set<string>();
  value.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      diagnostics.push(`Action ${index + 1} must be an object.`);
      return;
    }
    const action = candidate as Record<string, unknown>;
    const name = typeof action.name === "string" ? action.name.trim() : "";
    const invocation = action.action;
    const normalized = typeof invocation === "string"
      ? { run: invocation, with: {} }
      : invocation && typeof invocation === "object" && !Array.isArray(invocation)
        && typeof (invocation as Record<string, unknown>).run === "string"
        && ((invocation as Record<string, unknown>).with === undefined
          || ((invocation as Record<string, unknown>).with !== null
            && typeof (invocation as Record<string, unknown>).with === "object"
            && !Array.isArray((invocation as Record<string, unknown>).with)))
          ? {
              run: (invocation as { run: string }).run,
              with: ((invocation as { with?: Record<string, unknown> }).with ?? {}),
            }
          : undefined;
    if (!name) diagnostics.push(`Action ${index + 1} needs a non-empty name.`);
    if (!normalized || normalized.run.trim() === "") diagnostics.push(`Action ${index + 1} needs a valid action reference.`);
    if (name && names.has(name)) diagnostics.push(`Action name ${JSON.stringify(name)} is duplicated.`);
    if (name) names.add(name);
    if (name && normalized && normalized.run.trim() !== "") actions.push({ name, action: normalized });
  });
  return { actions, diagnostics };
}

export function resolveListItemAction(action: ListItemAction, item: DashboardListItem): ResolvedListItemAction {
  try {
    const withArgs = resolveItemValue(action.action.with, item);
    if (!withArgs || typeof withArgs !== "object" || Array.isArray(withArgs)) {
      throw new Error("action arguments must resolve to an object.");
    }
    return { invocation: { run: action.action.run, with: withArgs as Record<string, unknown> } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveItemValue(value: unknown, item: DashboardListItem): unknown {
  if (typeof value === "string") {
    const match = ITEM_TEMPLATE.exec(value);
    if (match) {
      const field = match[1]!;
      if (!Object.prototype.hasOwnProperty.call(item, field) || item[field] === undefined) {
        throw new Error(`item.${field} is missing from this source item.`);
      }
      return copyJsonValue(item[field], `item.${field}`);
    }
    if (value.includes("${item.")) throw new Error("Item templates must be the full value of an action argument.");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveItemValue(entry, item));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Action arguments must contain JSON values.");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveItemValue(entry, item)]));
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  throw new Error("Action arguments must contain JSON values or item field templates.");
}

function copyJsonValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => copyJsonValue(entry, field));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} has an unsupported value type.`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyJsonValue(entry, field)]));
  }
  throw new Error(`${field} has an unsupported value type.`);
}

export function parseDashboardList(value: unknown): {
  items: DashboardListItem[];
  diagnostics: ListShapeDiagnostic[];
} {
  if (!Array.isArray(value)) {
    return { items: [], diagnostics: [{ message: "Expected a JSON array of list items." }] };
  }
  const diagnostics: ListShapeDiagnostic[] = [];
  const items: DashboardListItem[] = [];
  const ids = new Set<string>();

  value.forEach((candidate, index) => {
    const diagnose = (message: string): void => { diagnostics.push({ index, message }); };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      diagnose("Expected an object with string id and title fields.");
      return;
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.trim() === "") {
      diagnose("id must be a non-empty string owned by the source.");
      return;
    }
    if (ids.has(item.id)) {
      diagnose(`id ${JSON.stringify(item.id)} is duplicated; IDs must be unique.`);
      return;
    }
    ids.add(item.id);
    if (typeof item.title !== "string" || item.title.trim() === "") {
      diagnose("title must be a non-empty string.");
      return;
    }
    let valid = true;
    if (item.detail !== undefined && typeof item.detail !== "string") {
      diagnose("detail must be a string when provided.");
      valid = false;
    }
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string"))) {
      diagnose("tags must be an array of strings when provided.");
      valid = false;
    }
    if (item.state !== undefined && typeof item.state !== "string") {
      diagnose("state must be a string when provided.");
      valid = false;
    }
    if (item.done !== undefined && typeof item.done !== "boolean") {
      diagnose("done must be a boolean when provided.");
      valid = false;
    }
    if (valid) items.push(item as DashboardListItem);
  });
  return { items, diagnostics };
}

export function filterListItems(items: readonly DashboardListItem[], tag: string): DashboardListItem[] {
  return tag === "" ? [...items] : items.filter((item) => item.tags?.includes(tag));
}

export function sortListItems(items: readonly DashboardListItem[], mode: "open-first" | "source-order"): DashboardListItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (mode === "open-first") {
        const leftClosed = left.item.done === true || ["done", "completed", "closed"].includes(left.item.state?.toLowerCase() ?? "");
        const rightClosed = right.item.done === true || ["done", "completed", "closed"].includes(right.item.state?.toLowerCase() ?? "");
        if (leftClosed !== rightClosed) return Number(leftClosed) - Number(rightClosed);
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function listTags(items: readonly DashboardListItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.tags ?? []))].sort((left, right) => left.localeCompare(right));
}
