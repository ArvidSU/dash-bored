export interface ReferenceLocation {
  parent: Record<string, unknown>;
  key: string;
  path: string;
}

/**
 * Find every prop location named by a manifest reference path such as
 * `items.*.action`. A trailing `*` makes each array item a reference; its
 * location is the array and the item's index, so writes replace the item.
 */
export function referenceLocations(root: Record<string, unknown>, path: string): ReferenceLocation[] {
  const parts = path.split(".");
  const locations: ReferenceLocation[] = [];
  const visit = (value: unknown, index: number, prefix: string[]): void => {
    if (index >= parts.length) return;
    const part = parts[index]!;
    if (index === parts.length - 1) {
      if (part === "*") {
        if (Array.isArray(value)) value.forEach((_item, itemIndex) => {
          locations.push({ parent: value as unknown as Record<string, unknown>, key: String(itemIndex), path: [...prefix, String(itemIndex)].join(".") });
        });
      } else if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, part)) {
        locations.push({ parent: value as Record<string, unknown>, key: part, path: [...prefix, part].join(".") });
      }
      return;
    }
    if (part === "*") {
      if (Array.isArray(value)) value.forEach((item, itemIndex) => visit(item, index + 1, [...prefix, String(itemIndex)]));
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, part)) {
      visit((value as Record<string, unknown>)[part], index + 1, [...prefix, part]);
    }
  };
  visit(root, 0, []);
  return locations;
}
