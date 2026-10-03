import { useContext, useMemo } from "react";
import type { ReactNode } from "react";
import "./list.css";
import { StateGlyph, isClosedState, stateTone } from "../../lib/state-visual";
import { useChangedItems } from "../../lib/observation-changes";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { ComponentVisibilityContext } from "../../composition/ComponentCompositor";
import { listTags, parseDashboardList, parseListItemActions, resolveListItemAction, sortListItems, filterListItems } from "../../lib/list-data";
import type { DashboardSource } from "../../lib/source";
import { useSourceComponent } from "../../lib/use-dashboard-source";
import { TodoList } from "../todo-list";
import { TagFilter } from "../tag-filter";
import { processRun, processRunFailed, processRunOutcome } from "../../../shared/process-state";

/**
 * The shared process run belongs to this item only if its invocation started
 * that run; a persistent terminal outlives many runs, so compare run starts.
 */
function invocationProcessRun(action: ReturnType<ComponentRendererProps["host"]["actions"]["resolve"]>) {
  const { invocation } = action;
  const run = processRun(action.process);
  if (!invocation?.finishedAt || !run?.startedAt) return undefined;
  const runStartedAt = Date.parse(run.startedAt);
  return Date.parse(invocation.startedAt) <= runStartedAt && runStartedAt <= Date.parse(invocation.finishedAt) ? run : undefined;
}

export default function List(input: ComponentRendererProps): ReactNode {
  if (Object.prototype.hasOwnProperty.call(input.props, "todos")) {
    return <TodoList props={input.props} host={input.host} refreshAction />;
  }
  return <SourceList {...input} />;
}

function SourceList({ props, host }: ComponentRendererProps): ReactNode {
  const source = props.source && typeof props.source === "object" ? props.source as DashboardSource : undefined;
  // The filter resets only when its data provider changes. Inline observations
  // and polling settings are data updates, so they retain a still-valid tag.
  const env = source?.env ? Object.fromEntries(Object.entries(source.env).sort(([left], [right]) => left.localeCompare(right))) : undefined;
  const provider = source
    ? source.shell !== undefined ? { kind: "shell", value: source.shell, cwd: source.cwd, env }
      : source.file !== undefined ? { kind: "file", value: source.file }
        : source.http !== undefined ? { kind: "http", value: source.http }
          : source.process !== undefined ? { kind: "process", value: source.process }
            : { kind: "inline" }
    : null;
  return <SourceListInstance props={props} host={host} source={source} filterKey={JSON.stringify(provider)} />;
}

function SourceListInstance({ props, host, source, filterKey }: ComponentRendererProps & { source?: DashboardSource; filterKey: string }): ReactNode {
  const visible = useContext(ComponentVisibilityContext);
  const title = stringProp(props, ["title"], "List");
  const filterByTags = props.filterByTags !== false;
  const sortMode = props.sort === "source-order" ? "source-order" : "open-first";
  const { state, unavailable, refresh } = useSourceComponent(source ?? null, host, {
    label: `Refresh ${title}`,
    withoutSource: "Configure a source before refreshing.",
    unavailableReason: (missing) => `Trust this project and grant ${missing} to read this source.`,
  });

  const parsed = useMemo(
    () => state.value === undefined ? { items: [], diagnostics: [] } : parseDashboardList(state.value),
    [state.value],
  );
  const configuredActions = useMemo(() => parseListItemActions(props.itemActions), [props.itemActions]);
  const observed = useChangedItems(state.value === undefined ? undefined : parsed.items, props.highlightChanges !== false);
  const changedAt = observed.at?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tags = useMemo(() => listTags(parsed.items), [parsed.items]);

  if (!source) return <p className="component-state component-state--error" role="alert">List needs a source.</p>;
  if (unavailable) return <CapabilityGate title={title}>Trust this project and grant {unavailable} to read this source.</CapabilityGate>;

  return <TagFilter key={filterKey} host={host} tags={tags} enabled={filterByTags}>{(filterTag, setFilterTag) => {
  const displayed = sortListItems(filterListItems(parsed.items, filterTag), sortMode);
  return <section className="source-list" data-refreshing={state.loading && state.value !== undefined || undefined} aria-label={title}>
    <header className="source-list__header">
      <div><strong>{title}</strong><span>{parsed.items.length} items{observed.changes.size ? ` · ${observed.changes.size} changed at ${changedAt}` : ""}</span></div>
      <div className="source-list__controls">
        {filterByTags && tags.length > 0 ? <label>
          <span>Tag</span>
          <select value={filterTag} onChange={(event) => setFilterTag(event.target.value)}>
            <option value="">All tags</option>
            {tags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}
          </select>
        </label> : null}
        <button className="button button--quiet" type="button" onClick={refresh} disabled={state.loading}>Refresh</button>
      </div>
    </header>
    {state.loading && state.value === undefined ? <p className="component-state" role="status">Loading…</p> : null}
    {state.loading && state.value !== undefined ? <small className="visually-hidden" role="status">Updating…</small> : null}
    {state.error ? <p className="component-state component-state--error" role="alert">{state.value === undefined ? "Source error" : "Showing stale data"}: {state.error}</p> : null}
    {parsed.diagnostics.length ? <ul className="source-list__diagnostics" role="alert" aria-label="List source shape errors">
      {parsed.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.index ?? "root"}-${index}`}>
        {diagnostic.index === undefined ? "Source" : `Item ${diagnostic.index + 1}`}: {diagnostic.message}
      </li>)}
    </ul> : null}
    {configuredActions.diagnostics.length ? <ul className="source-list__diagnostics" role="alert" aria-label="List action configuration errors">
      {configuredActions.diagnostics.map((message, index) => <li key={index}>{message}</li>)}
    </ul> : null}
    {displayed.length ? <ul className="source-list__items" aria-label="Items">
      {displayed.map((item) => {
        const change = observed.changes.get(item.id);
        return <li key={item.id} data-item-id={item.id} data-tone={stateTone(item.state, item.done)} data-change={change}
          data-flash={change && observed.flashing || undefined}
          className={isClosedState(item.state, item.done) ? "source-list__item source-list__item--closed" : "source-list__item"}>
        <div className="source-list__item-leading"><span className="source-list__glyph"><StateGlyph tone={stateTone(item.state, item.done)} /></span><div className="source-list__item-text"><strong>{item.title}</strong>{typeof item.detail === "string" ? <span>{item.detail}</span> : null}</div></div>
        <div className="source-list__item-trailing">
          <div className="source-list__item-meta">
            {change ? <span className="source-list__change" title={`${change === "new" ? "New" : "Changed"} in the update at ${changedAt}`}>{change === "new" ? "New" : "Changed"}</span> : null}
            {typeof item.state === "string" ? <span className="source-list__state">{item.state}</span> : null}
            {item.tags?.map((tag, index) => <span className="source-list__tag" key={`${tag}-${index}`}>{tag}</span>)}
          </div>
          {configuredActions.actions.length ? <div className="source-list__item-actions" aria-label={`Actions for ${item.title}`}>
            {configuredActions.actions.map((configuredAction) => {
              const resolved = resolveListItemAction(configuredAction, item);
              const invocationKey = `${item.id}:${configuredAction.name}`;
              const action = resolved.invocation ? host.actions.resolve(resolved.invocation.run, invocationKey) : undefined;
              const ownedRun = action ? invocationProcessRun(action) : undefined;
              const disabledReason = resolved.error ?? (action && !action.enabled ? action.disabledReason ?? "This action is unavailable." : undefined);
              return <div className="source-list__item-action" key={configuredAction.name}>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={!resolved.invocation || Boolean(disabledReason) || Boolean(action?.running)}
                  title={disabledReason}
                  onClick={() => {
                    if (resolved.invocation) host.actions.invoke(resolved.invocation.run, resolved.invocation.with, undefined, invocationKey);
                  }}
                >
                  {configuredAction.name}{action?.running ? " · Running" : ""}
                </button>
                {action?.invocation?.status === "failed" ? <small role="alert">{action.invocation.message ?? "Action failed."}</small> : null}
                {ownedRun && (ownedRun.phase === "running" || ownedRun.phase === "stopping")
                  ? <small role="status">Running</small>
                  : ownedRun ? <small role="status">{processRunFailed(ownedRun) ? `Failed: ${processRunOutcome(ownedRun)}` : "Finished"}</small>
                    : null}
                {resolved.error ? <small role="alert">{resolved.error}</small> : null}
              </div>;
            })}
          </div> : null}
        </div>
      </li>;
      })}
    </ul> : state.value !== undefined && parsed.diagnostics.length === 0 ? <p className="source-list__empty">No matching items.</p> : null}
    {!visible ? <small>Paused while hidden</small> : null}
  </section>;
  }}</TagFilter>;
}
