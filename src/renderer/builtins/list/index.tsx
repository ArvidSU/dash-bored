import { useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import "./list.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { ComponentVisibilityContext } from "../../composition/ComponentCompositor";
import { listTags, parseDashboardList, parseListItemActions, resolveListItemAction, sortListItems, filterListItems } from "../../lib/list-data";
import { readDashboardSource, type DashboardSource } from "../../lib/source";
import { TodoList } from "../todo-list";

type SourceState = { value?: unknown; error?: string; loading: boolean };

export default function List(input: ComponentRendererProps): ReactNode {
  if (Object.prototype.hasOwnProperty.call(input.props, "todos")) {
    return <TodoList props={input.props} host={input.host} refreshAction />;
  }
  return <SourceList {...input} />;
}

function SourceList({ props, host }: ComponentRendererProps): ReactNode {
  const visible = useContext(ComponentVisibilityContext);
  const source = props.source && typeof props.source === "object" ? props.source as DashboardSource : undefined;
  const sourceKey = JSON.stringify(source);
  const every = typeof source?.every === "number" ? Math.max(1000, Math.min(300000, source.every)) : undefined;
  const title = stringProp(props, ["title"], "List");
  const filterByTags = props.filterByTags !== false;
  const sortMode = props.sort === "source-order" ? "source-order" : "open-first";
  const [refresh, setRefresh] = useState(0);
  const [filterTag, setFilterTag] = useState("");
  const [state, setState] = useState<SourceState>({ loading: true });
  const processSnapshot = source?.process ? host.processes?.get(source.process) : undefined;
  const permission = source?.shell ? "process:execute"
    : source?.http ? "network:http"
      : source?.process ? "process:observe"
        : source?.file ? "filesystem:read" : undefined;
  const canRead = permission === undefined
    || permission === "process:execute" && Boolean(host.shell)
    || permission === "network:http" && Boolean(host.http)
    || permission === "process:observe" && Boolean(host.processes)
    || permission === "filesystem:read" && Boolean(host.filesystem);

  useEffect(() => host.actions.register({
    id: "refresh",
    label: `Refresh ${title}`,
    enabled: Boolean(source) && canRead,
    disabledReason: !source ? "Configure a source before refreshing."
      : canRead ? undefined : `Trust this project and grant ${permission} to read this source.`,
    run: () => setRefresh((current) => current + 1),
  }), [canRead, host.actions, permission, source, title]);

  useEffect(() => {
    if (!visible || !source || !canRead) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      setState((old) => ({ ...old, loading: true, error: undefined }));
      try {
        const value = await readDashboardSource(source, host);
        if (!cancelled) setState({ value, loading: false });
      } catch (cause) {
        if (!cancelled) setState((old) => ({
          ...old,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      } finally {
        if (!cancelled && every !== undefined) timer = window.setTimeout(() => void load(), every);
      }
    };
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [canRead, every, host, refresh, sourceKey, visible]);

  useEffect(() => {
    if (source?.process && processSnapshot !== undefined) setState({ value: processSnapshot, loading: false });
  }, [processSnapshot, source?.process]);

  const parsed = useMemo(
    () => state.value === undefined ? { items: [], diagnostics: [] } : parseDashboardList(state.value),
    [state.value],
  );
  const configuredActions = useMemo(() => parseListItemActions(props.itemActions), [props.itemActions]);
  const tags = useMemo(() => listTags(parsed.items), [parsed.items]);
  useEffect(() => {
    if (filterTag !== "" && !tags.includes(filterTag)) setFilterTag("");
  }, [filterTag, tags]);
  const displayed = useMemo(
    () => sortListItems(filterListItems(parsed.items, filterTag), sortMode),
    [filterTag, parsed.items, sortMode],
  );

  if (!source) return <p className="component-state component-state--error" role="alert">List needs a source.</p>;
  if (!canRead) return <CapabilityGate title={title}>Trust this project and grant {permission} to read this source.</CapabilityGate>;

  return <section className="source-list" aria-label={title}>
    <header className="source-list__header">
      <div><strong>{title}</strong><span>{parsed.items.length} items</span></div>
      <div className="source-list__controls">
        {filterByTags && tags.length > 0 ? <label>
          <span>Tag</span>
          <select value={filterTag} onChange={(event) => setFilterTag(event.target.value)}>
            <option value="">All tags</option>
            {tags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}
          </select>
        </label> : null}
        <button className="button button--quiet" type="button" onClick={() => setRefresh((current) => current + 1)} disabled={state.loading}>Refresh</button>
      </div>
    </header>
    {state.loading && state.value === undefined ? <p className="component-state" role="status">Loading…</p> : null}
    {state.loading && state.value !== undefined ? <small role="status">Updating…</small> : null}
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
      {displayed.map((item) => <li key={item.id} className={item.done || ["done", "completed", "closed"].includes(item.state?.toLowerCase() ?? "") ? "source-list__item source-list__item--closed" : "source-list__item"}>
        <div className="source-list__item-text"><strong>{item.title}</strong>{typeof item.detail === "string" ? <span>{item.detail}</span> : null}</div>
        <div className="source-list__item-trailing">
          <div className="source-list__item-meta">
            {typeof item.state === "string" ? <span className="source-list__state">{item.state}</span> : null}
            {item.tags?.map((tag, index) => <span className="source-list__tag" key={`${tag}-${index}`}>{tag}</span>)}
          </div>
          {configuredActions.actions.length ? <div className="source-list__item-actions" aria-label={`Actions for ${item.title}`}>
            {configuredActions.actions.map((configuredAction) => {
              const resolved = resolveListItemAction(configuredAction, item);
              const invocationKey = `${item.id}:${configuredAction.name}`;
              const action = resolved.invocation ? host.actions.resolve(resolved.invocation.run, invocationKey) : undefined;
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
                {action?.invocation?.outcome === "started" ? <small role="status">Started</small> : null}
                {action?.process?.phase === "exited" && action.invocation ? <small role="status">{action.process.exitCode === 0 ? "Finished" : `Failed: exit ${action.process.exitCode}`}</small> : null}
                {resolved.error ? <small role="alert">{resolved.error}</small> : null}
              </div>;
            })}
          </div> : null}
        </div>
      </li>)}
    </ul> : state.value !== undefined && parsed.diagnostics.length === 0 ? <p className="source-list__empty">No matching items.</p> : null}
    {!visible ? <small>Paused while hidden</small> : null}
  </section>;
}
