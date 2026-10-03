import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { LocalComponentHost } from "../../shared/contracts";

interface TagFilterProps {
  host: LocalComponentHost;
  tags: readonly string[];
  enabled?: boolean;
  children(filterTag: string, setFilterTag: (tag: string) => void): ReactNode;
}

/** Owns only filter state, so refreshing data never remounts editable rows. */
export function TagFilter({ host, tags, enabled = true, children }: TagFilterProps): ReactNode {
  const [filterTag, setFilterTag] = useState("");
  if (filterTag !== "" && (!enabled || !tags.includes(filterTag))) setFilterTag("");

  useEffect(() => {
    const unregister = [
      host.actions.register({
        id: "clear-filter",
        label: "Clear list tag filter",
        enabled: filterTag !== "",
        disabledReason: "No tag filter is selected.",
        run: () => setFilterTag(""),
      }),
      host.actions.register({
        id: "filter",
        label: "Filter list by tag",
        enabled: enabled && (tags.length > 0 || filterTag !== ""),
        disabledReason: enabled ? "This list has no tags." : "Tag filtering is disabled.",
        choices: [{ id: "tag", label: "Choose a tag", options: () => tags.map((tag) => ({ value: tag, label: tag })) }],
        run: (selections, args) => {
          const tag = args?.tag ?? selections?.tag ?? "";
          if (typeof tag !== "string" || tag !== "" && !tags.includes(tag)) throw new Error("Choose a current list tag.");
          setFilterTag(tag);
        },
      }),
    ];
    return () => unregister.forEach((remove) => remove());
  }, [host.actions, enabled, tags, filterTag]);

  return children(filterTag, setFilterTag);
}
