import {
  lazy,
  Suspense,
  type ComponentType,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { CapabilityGate, stringProp } from "./builtins/shared";
import type { ComponentRendererProps, PackagedComponent } from "./builtins/types";
import {
  CHART_COLORS,
  limitChartData,
  parseChartData,
  readChartDataPath,
  resolveChartEndpoint,
  type ChartData,
  type ChartSeries,
  type ChartValue,
} from "./chart-data";
import {
  appendEnvEntry,
  envEntries,
  invalidEnvLineCount,
  isValidEnvKey,
  parseEnv,
  removeEnvEntry,
  serializeEnv,
  updateEnvEntry,
  type EnvDocument,
} from "./env";
import { ComponentVisibilityContext } from "./ComponentCompositor";
import { TodoList } from "./todo-list";

function Status({ props }: ComponentRendererProps): ReactNode {
  const label = stringProp(props, ["label", "name"], "Status");
  const value = stringProp(props, ["state", "status", "value"], "unknown");
  const detail = stringProp(props, ["detail", "description"]);
  const normalized = value.toLowerCase();
  const tone = ["ok", "online", "healthy", "success", "ready"].includes(normalized)
    ? "positive"
    : ["warn", "warning", "pending", "starting"].includes(normalized)
      ? "warning"
      : ["error", "failed", "offline", "down"].includes(normalized)
        ? "negative"
        : "neutral";
  return (
    <div className="status">
      <span className={`status__dot status__dot--${tone}`} aria-hidden="true" />
      <span className="status__label">{label}</span>
      <span className="status__value">{value}</span>
      {detail ? <span className="status__detail">{detail}</span> : null}
    </div>
  );
}

type ChartType = "line" | "bar";

function numberProp(
  props: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = props[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function chartType(props: Record<string, unknown>): ChartType {
  return props.type === "bar" ? "bar" : "line";
}

function chartTitle(props: Record<string, unknown>, fallback: string): string {
  return stringProp(props, ["title"], fallback);
}

function chartColor(series: ChartSeries, index: number): string {
  return series.color ?? CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}

function formatChartValue(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function chartPath(
  values: ChartValue[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const segments: string[] = [];
  let segment: string[] = [];

  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (segment.length > 0) segments.push(segment.join(" "));
      segment = [];
      return;
    }
    const command = segment.length === 0 ? "M" : "L";
    segment.push(`${command} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`);
  });
  if (segment.length > 0) segments.push(segment.join(" "));
  return segments.join(" ");
}

function ChartSvg({
  data,
  type,
  title,
}: {
  data: ChartData;
  type: ChartType;
  title: string;
}): ReactNode {
  const width = 720;
  const height = 280;
  const padding = { top: 18, right: 18, bottom: 42, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = data.series.flatMap((series) =>
    series.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );

  if (values.length === 0) {
    return <div className="component-state">Waiting for numeric chart values.</div>;
  }

  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    const paddingValue = Math.max(Math.abs(min) * 0.15, 1);
    min -= paddingValue;
    max += paddingValue;
  }

  const x = (index: number): number =>
    data.labels.length <= 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (data.labels.length - 1)) * plotWidth;
  const y = (value: number): number =>
    padding.top + ((max - value) / (max - min)) * plotHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = max - ((max - min) * index) / 4;
    return { value, y: y(value) };
  });
  const labelIndexes =
    data.labels.length <= 8
      ? data.labels.map((_, index) => index)
      : [...new Set([0, Math.floor((data.labels.length - 1) / 2), data.labels.length - 1])];
  const barGroupWidth = plotWidth / Math.max(data.labels.length, 1);
  const barWidth = Math.max(
    2,
    Math.min(26, (barGroupWidth * 0.72) / Math.max(data.series.length, 1)),
  );

  return (
    <svg
      className="chart__svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${title}, ${data.series.length} series over ${data.labels.length} points`}
    >
      <title>{title}</title>
      {ticks.map((tick) => (
        <g key={tick.value}>
          <line
            className="chart__grid"
            x1={padding.left}
            x2={width - padding.right}
            y1={tick.y}
            y2={tick.y}
          />
          <text className="chart__axis-label" x={padding.left - 9} y={tick.y + 3} textAnchor="end">
            {formatChartValue(tick.value)}
          </text>
        </g>
      ))}
      <line
        className="chart__axis"
        x1={padding.left}
        x2={width - padding.right}
        y1={padding.top + plotHeight}
        y2={padding.top + plotHeight}
      />
      {type === "line"
        ? data.series.map((series, seriesIndex) => (
            <g key={series.label}>
              <path
                className="chart__line"
                d={chartPath(series.values, x, y)}
                stroke={chartColor(series, seriesIndex)}
              />
              {series.values.map((value, index) =>
                typeof value === "number" && Number.isFinite(value) ? (
                  <circle
                    className="chart__point"
                    cx={x(index)}
                    cy={y(value)}
                    fill={chartColor(series, seriesIndex)}
                    key={index}
                    r="3"
                  />
                ) : null,
              )}
            </g>
          ))
        : data.series.map((series, seriesIndex) =>
            series.values.map((value, index) => {
              if (typeof value !== "number" || !Number.isFinite(value)) return null;
              const barX =
                padding.left +
                index * barGroupWidth +
                (barGroupWidth - barWidth * data.series.length) / 2 +
                seriesIndex * barWidth;
              const zeroY = y(0);
              const valueY = y(value);
              return (
                <rect
                  className="chart__bar"
                  fill={chartColor(series, seriesIndex)}
                  height={Math.max(Math.abs(zeroY - valueY), 1)}
                  key={`${series.label}-${index}`}
                  rx="2"
                  width={Math.max(barWidth - 2, 1)}
                  x={barX}
                  y={Math.min(zeroY, valueY)}
                />
              );
            }),
          )}
      {labelIndexes.map((index) => (
        <text
          className="chart__x-label"
          key={index}
          x={x(index)}
          y={height - 13}
          textAnchor={index === 0 ? "start" : index === data.labels.length - 1 ? "end" : "middle"}
        >
          {data.labels[index]}
        </text>
      ))}
    </svg>
  );
}

function ChartPanel({
  data,
  error,
  loading,
  onRefresh,
  status,
  title,
  type,
  updatedAt,
}: {
  data: ChartData | null;
  error?: string | null;
  loading?: boolean;
  onRefresh?: () => void;
  status?: string;
  title: string;
  type: ChartType;
  updatedAt?: Date | null;
}): ReactNode {
  return (
    <section className="chart" aria-label={title}>
      <header className="chart__header">
        <div className="chart__heading">
          <strong>{title}</strong>
          {status ? <span>{status}</span> : null}
        </div>
        {onRefresh ? (
          <button className="button button--quiet button--small" type="button" onClick={onRefresh}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        ) : null}
      </header>
      {error ? <div className="chart__error" role="alert">{error}</div> : null}
      {data ? (
        <ChartSvg data={data} title={title} type={type} />
      ) : (
        <div className="component-state">{loading ? "Loading chart data…" : "No chart data yet."}</div>
      )}
      {data ? (
        <footer className="chart__footer">
          <div className="chart__legend">
            {data.series.map((series, index) => (
              <span className="chart__legend-item" key={series.label}>
                <i style={{ backgroundColor: chartColor(series, index) }} />
                {series.label}
              </span>
            ))}
          </div>
          {updatedAt ? <span>Updated {updatedAt.toLocaleTimeString()}</span> : null}
        </footer>
      ) : null}
    </section>
  );
}

function Chart({ props }: ComponentRendererProps): ReactNode {
  const rawData = parseChartData({ labels: props.labels, series: props.series });
  const data = rawData
    ? limitChartData(rawData, numberProp(props, "maxPoints", 60))
    : null;
  return (
    <ChartPanel
      data={data}
      status={chartType(props)}
      title={chartTitle(props, "Chart")}
      type={chartType(props)}
    />
  );
}

function LiveChart({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const http = componentHost.http;
  const endpoint = stringProp(props, ["endpoint"]);
  const dataPath = stringProp(props, ["dataPath"]);
  const pollIntervalMs = numberProp(props, "pollIntervalMs", 5000);
  const maxPoints = numberProp(props, "maxPoints", 60);
  const title = chartTitle(props, "Live chart");
  const type = chartType(props);
  const panelVisible = useContext(ComponentVisibilityContext);
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const resolvedEndpoint = useMemo(
    () => resolveChartEndpoint(endpoint, window.location.href),
    [endpoint],
  );

  useEffect(() => {
    const requestEndpoint = resolvedEndpoint;
    if (!http || !panelVisible || requestEndpoint === null) return;
    const client = http;
    const requestUrl: string = requestEndpoint;
    let cancelled = false;
    let timer: number | undefined;

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const response = await client.request({ url: requestUrl });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Endpoint returned HTTP ${response.status}.`);
        }
        const payload: unknown = JSON.parse(response.body);
        const parsed = parseChartData(readChartDataPath(payload, dataPath));
        if (!parsed) throw new Error("Endpoint did not return chart data.");
        if (!cancelled) {
          setData(limitChartData(parsed, maxPoints));
          setError(null);
          setUpdatedAt(new Date());
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = window.setTimeout(() => void load(), pollIntervalMs);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [dataPath, http, maxPoints, panelVisible, pollIntervalMs, refreshKey, resolvedEndpoint]);

  if (!http) {
    return (
      <CapabilityGate title={title}>
        Trust this project to make the configured HTTP request.
      </CapabilityGate>
    );
  }

  if (resolvedEndpoint === null) {
    return (
      <div className="component-state component-state--error" role="alert">
        The live chart requires an HTTP(S) endpoint or an app-relative path.
      </div>
    );
  }

  const status = panelVisible
    ? `Polling every ${Math.round(pollIntervalMs / 1000)}s`
    : "Paused while hidden";
  return (
    <ChartPanel
      data={data}
      error={error}
      loading={loading}
      onRefresh={() => setRefreshKey((value) => value + 1)}
      status={status}
      title={title}
      type={type}
      updatedAt={updatedAt}
    />
  );
}

function FileViewer({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const filesystem = componentHost.filesystem;
  const path = stringProp(props, ["path"]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!filesystem || !path) return;

    setLoading(true);
    setError(null);
    void filesystem
      .readText(path)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filesystem, path, refresh]);

  if (!filesystem) {
    return (
      <CapabilityGate title={path || "File viewer"}>
        Trust this project to read workspace files.
      </CapabilityGate>
    );
  }

  return (
    <section className="file-viewer">
      <header className="file-viewer__header">
        <code>{path || "No file configured"}</code>
        <button className="button button--quiet" type="button" disabled={!path || loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </header>
      {error ? <div className="component-state component-state--error" role="alert">{error}</div> : null}
      {!error ? <pre className="file-viewer__content"><code>{content}</code></pre> : null}
    </section>
  );
}

function EnvEditor({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const filesystem = componentHost.filesystem;
  const editorId = useId().replaceAll(":", "");
  const path = stringProp(props, ["path"]);
  const [document, setDocument] = useState<EnvDocument>(() => parseEnv(""));
  const [rawSource, setRawSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [mode, setMode] = useState<"table" | "raw">("table");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!filesystem || !path) return;

    setLoading(true);
    setError(null);
    void filesystem
      .readText(path)
      .then((source) => {
        if (cancelled) return;
        setDocument(parseEnv(source));
        setRawSource(source);
        setSavedSource(source);
        setMode("table");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filesystem, path, refresh]);

  const tableSource = serializeEnv(document);
  const content = mode === "raw" ? rawSource : tableSource;
  const dirty = content !== savedSource;
  const rows = envEntries(document);
  const invalidKeys = rows.filter(({ entry }) => !isValidEnvKey(entry.key)).length;
  const invalidLines = invalidEnvLineCount(document);

  function switchMode(nextMode: "table" | "raw"): void {
    if (nextMode === mode) return;
    if (nextMode === "raw") {
      setRawSource(tableSource);
    } else {
      setDocument(parseEnv(rawSource));
    }
    setMode(nextMode);
    setError(null);
  }

  function updateEntry(
    lineIndex: number,
    field: "key" | "value",
    value: string,
  ): void {
    const nextDocument = updateEnvEntry(document, lineIndex, { [field]: value });
    setDocument(nextDocument);
    setRawSource(serializeEnv(nextDocument));
    setError(null);
  }

  function addEntry(): void {
    const nextDocument = appendEnvEntry(document);
    setDocument(nextDocument);
    setRawSource(serializeEnv(nextDocument));
    setError(null);
  }

  function deleteEntry(lineIndex: number): void {
    const nextDocument = removeEnvEntry(document, lineIndex);
    setDocument(nextDocument);
    setRawSource(serializeEnv(nextDocument));
    setError(null);
  }

  async function save(): Promise<void> {
    if (!path || !dirty || invalidKeys > 0) return;
    setSaving(true);
    setError(null);
    try {
      if (!filesystem?.writeText) throw new Error("This component does not have file-write access.");
      await filesystem.writeText(path, content);
      setSavedSource(content);
      if (mode === "table") setRawSource(content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!filesystem?.writeText) {
    return (
      <CapabilityGate title="Environment editor">
        Trust this project to read and write the configured environment file.
      </CapabilityGate>
    );
  }

  if (!path) {
    return (
      <div className="component-state component-state--error" role="alert">
        Configure a relative environment file path first.
      </div>
    );
  }

  return (
    <section className="env-editor" aria-label={`Environment editor for ${path}`}>
      <header className="env-editor__header">
        <div className="env-editor__title">
          <span className="env-editor__glyph" aria-hidden="true">{`{ }`}</span>
          <div>
            <strong>Environment variables</strong>
            <code title={path}>{path}</code>
          </div>
        </div>
        <div className="env-editor__actions">
          <div className="env-editor__mode" role="group" aria-label="Editor mode">
            <button
              className={mode === "table" ? "env-editor__mode-button env-editor__mode-button--active" : "env-editor__mode-button"}
              type="button"
              aria-pressed={mode === "table"}
              onClick={() => switchMode("table")}
            >
              Key-value
            </button>
            <button
              className={mode === "raw" ? "env-editor__mode-button env-editor__mode-button--active" : "env-editor__mode-button"}
              type="button"
              aria-pressed={mode === "raw"}
              onClick={() => switchMode("raw")}
            >
              Bulk / raw
            </button>
          </div>
          <button className="button button--quiet" type="button" disabled={loading || saving} onClick={() => setRefresh((value) => value + 1)}>
            {loading ? "Reading…" : "Reload"}
          </button>
          <button className="button button--primary" type="button" disabled={loading || saving || !dirty || invalidKeys > 0} onClick={() => void save()}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </header>
      {error ? <div className="component-state component-state--error" role="alert">{error}</div> : null}
      {mode === "raw" ? (
        <div className="env-editor__raw-wrap">
          <label className="visually-hidden" htmlFor={`${editorId}-env-raw`}>Raw environment file</label>
          <textarea
            id={`${editorId}-env-raw`}
            className="env-editor__raw"
            value={rawSource}
            onChange={(event) => {
              setRawSource(event.target.value);
              setError(null);
            }}
            spellCheck={false}
          />
          <p className="env-editor__hint">Paste or edit the complete file, then save when ready.</p>
        </div>
      ) : (
        <div className="env-editor__table-wrap">
          {invalidLines > 0 ? (
            <p className="env-editor__notice">
              {invalidLines} unrecognized {invalidLines === 1 ? "line is" : "lines are"} preserved below in the raw file.
            </p>
          ) : null}
          {invalidKeys > 0 ? (
            <p className="env-editor__error" role="alert">Use letters, numbers, and underscores for variable names; names must not start with a number.</p>
          ) : null}
          {rows.length > 0 ? (
            <table className="env-editor__table">
              <thead>
                <tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map(({ lineIndex, entry }) => {
                  const validKey = isValidEnvKey(entry.key);
                  return (
                    <tr key={lineIndex}>
                      <td>
                        <input
                          className={validKey ? "env-editor__input env-editor__key" : "env-editor__input env-editor__key env-editor__input--invalid"}
                          aria-label={`Variable name ${lineIndex + 1}`}
                          aria-invalid={!validKey}
                          value={entry.key}
                          onChange={(event) => updateEntry(lineIndex, "key", event.target.value)}
                          spellCheck={false}
                        />
                      </td>
                      <td>
                        <input
                          className="env-editor__input"
                          aria-label={`Variable value for ${entry.key || "unnamed variable"}`}
                          value={entry.value}
                          onChange={(event) => updateEntry(lineIndex, "value", event.target.value)}
                          spellCheck={false}
                        />
                      </td>
                      <td>
                        <button className="env-editor__delete" type="button" onClick={() => deleteEntry(lineIndex)} aria-label={`Remove ${entry.key || "unnamed variable"}`}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="env-editor__empty">
              <strong>No variables yet</strong>
              <span>Add the first key-value pair or switch to raw mode to paste a complete file.</span>
              <button className="button button--primary" type="button" onClick={addEntry}>+ Add first variable</button>
            </div>
          )}
          {rows.length > 0 ? (
            <button className="button button--quiet env-editor__add" type="button" onClick={addEntry}>+ Add variable</button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Webview({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const url = stringProp(props, ["url", "src"]);
  if (!componentHost.webview) {
    return (
      <CapabilityGate title="Embedded page">
        Trust this project to load its configured web page.
      </CapabilityGate>
    );
  }
  return componentHost.webview.render({ url });
}

const LazyTabs = lazy(() => import("./builtins/tabs"));
const LazyGroup = lazy(() => import("./builtins/group"));
const LazyCard = lazy(() => import("./builtins/card"));
const LazyText = lazy(() => import("./builtins/text"));
const LazyCommand = lazy(() => import("./builtins/command"));
const LazyMarkdown = lazy(() => import("./builtins/markdown"));

function ComponentLoading(): ReactNode {
  return <div className="component-state">Loading component…</div>;
}

function lazyBuiltin(
  Component: ComponentType<ComponentRendererProps>,
): PackagedComponent {
  return (props) => (
    <Suspense fallback={<ComponentLoading />}>
      <Component {...props} />
    </Suspense>
  );
}

const PACKAGED_COMPONENTS: Readonly<Record<string, PackagedComponent>> = Object.freeze({
  "@dash-bored/group": lazyBuiltin(LazyGroup),
  "@dash-bored/tabs": lazyBuiltin(LazyTabs),
  "@dash-bored/card": lazyBuiltin(LazyCard),
  "@dash-bored/text": lazyBuiltin(LazyText),
  "@dash-bored/markdown": lazyBuiltin(LazyMarkdown),
  "@dash-bored/status": Status,
  "@dash-bored/chart": Chart,
  "@dash-bored/live-chart": LiveChart,
  "@dash-bored/command": lazyBuiltin(LazyCommand),
  "@dash-bored/file": FileViewer,
  "@dash-bored/env": EnvEditor,
  "@dash-bored/todo-list": ({ props, host: componentHost }) => (
    <TodoList props={props} host={componentHost} />
  ),
  "@dash-bored/webview": Webview,
});

export function packagedComponent(reference: string): PackagedComponent | undefined {
  return PACKAGED_COMPONENTS[reference];
}
