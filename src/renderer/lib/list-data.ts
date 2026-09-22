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
