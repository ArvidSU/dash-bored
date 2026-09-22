import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import Chart, { chartTitle, numberProp } from "../chart";
import { stringProp } from "../shared";
import { resolveChartEndpoint } from "../../lib/chart-data";

/** Schema-v3 compatibility adapter; rendering, polling, and refresh use Chart's source view. */
export default function LiveChart({ props, host }: ComponentRendererProps): ReactNode {
  const endpoint = stringProp(props, ["endpoint"]);
  const resolvedEndpoint = resolveChartEndpoint(endpoint, window.location.href);
  if (!resolvedEndpoint) {
    return <div className="component-state component-state--error" role="alert">The live chart requires an HTTP(S) endpoint or an app-relative path.</div>;
  }
  const chartProps = {
    title: chartTitle(props, "Live chart"),
    type: props.type,
    maxPoints: numberProp(props, "maxPoints", 60),
    dataPath: stringProp(props, ["dataPath"]),
    source: {
      http: resolvedEndpoint,
      every: numberProp(props, "pollIntervalMs", 5000),
    },
  };
  return <Chart props={chartProps} host={host} />;
}
