import { CORE_REFERENCE_PREFIX } from "./core-package";

/**
 * Pinned core components kept only so older dashboards keep working (roadmap WP9).
 * Keys are component names under CORE_REFERENCE_PREFIX; values are the replacement
 * hint rendered as `replacement: <hint>` by `inspect --summary` and by the generated
 * builtins reference. This map is the single source of truth for both.
 */
export const RETIRING_CORE_COMPONENTS: Readonly<Record<string, string>> = Object.freeze({
  card: "a titled `group`",
  tabs: "a `selection` with a `variant: tabs` button",
  "todo-list": "a `list` with `todos`",
  "live-chart": "a `chart` with `source`",
  conditional: "none yet; leave existing uses (planned: a source-bound `when` on the parent-child edge)",
  "setup-agent": "a `button` running `agent:prompt` with the setup prompt",
  "focus-timer": "a project-local component under `./components/`",
});

/** Replacement hint for a catalog reference, or undefined when it is not a retiring core component. */
export function retiringReplacement(reference: string): string | undefined {
  if (!reference.startsWith(CORE_REFERENCE_PREFIX)) return undefined;
  const name = reference.slice(CORE_REFERENCE_PREFIX.length);
  return Object.hasOwn(RETIRING_CORE_COMPONENTS, name) ? RETIRING_CORE_COMPONENTS[name] : undefined;
}
