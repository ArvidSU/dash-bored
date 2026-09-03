import { useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ComponentVisibilityContext } from "../../composition/ComponentCompositor";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { ChartPanel, chartTitle, chartType, numberProp } from "../chart";
import {
  limitChartData,
  parseChartData,
  readChartDataPath,
  resolveChartEndpoint,
  type ChartData,
} from "../../lib/chart-data";

export default function LiveChart({ props, host: componentHost }: ComponentRendererProps): ReactNode {
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
