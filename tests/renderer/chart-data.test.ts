import { describe, expect, test } from "bun:test";
import {
  limitChartData,
  parseChartData,
  readChartDataPath,
  resolveChartEndpoint,
} from "../../src/renderer/chart-data";

describe("chart data", () => {
  test("normalizes chart-shaped data and fills missing labels", () => {
    expect(
      parseChartData({
        series: {
          Requests: [3, 5, null, 8],
          Errors: [0, 1, 0, 2],
        },
      }),
    ).toEqual({
      labels: ["Point 1", "Point 2", "Point 3", "Point 4"],
      series: [
        { label: "Requests", values: [3, 5, null, 8] },
        { label: "Errors", values: [0, 1, 0, 2] },
      ],
    });
  });

  test("reads nested live payloads and rejects responses without series", () => {
    const payload = { metrics: { labels: ["A", "B"], series: [{ label: "CPU", values: [12, 18] }] } };

    expect(readChartDataPath(payload, "metrics")).toEqual(payload.metrics);
    expect(readChartDataPath(payload, "metrics.series")).toEqual(payload.metrics.series);
    expect(readChartDataPath(payload, "metrics.missing")).toBeUndefined();
    expect(parseChartData({ labels: ["A"] })).toBeNull();
  });

  test("keeps the newest bounded window for live histories", () => {
    const data = parseChartData({
      labels: ["1", "2", "3", "4"],
      series: [{ label: "Requests", values: [1, 2, 3, 4] }],
    });

    expect(data).not.toBeNull();
    expect(limitChartData(data!, 2)).toEqual({
      labels: ["3", "4"],
      series: [{ label: "Requests", values: [3, 4] }],
    });
  });

  test("resolves app-relative endpoints against the running renderer", () => {
    expect(resolveChartEndpoint("/metrics.json", "http://127.0.0.1:5569/")).toBe(
      "http://127.0.0.1:5569/metrics.json",
    );
    expect(resolveChartEndpoint("https://example.test/metrics.json", "http://127.0.0.1:5569/")).toBe(
      "https://example.test/metrics.json",
    );
    expect(resolveChartEndpoint("/metrics.json", "views://mainview/index.html")).toBeNull();
  });
});
