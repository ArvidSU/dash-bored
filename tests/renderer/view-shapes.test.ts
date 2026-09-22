import { describe, expect, test } from "bun:test";
import { parseSourceChart, parseStatusValue } from "../../src/renderer/lib/view-shapes";

describe("source-bound view shapes", () => {
  test("accepts status models and derives process outcomes", () => {
    expect(parseStatusValue({ state: "healthy", detail: "Ready" })).toEqual({ state: "healthy", detail: "Ready" });
    expect(parseStatusValue({ phase: "running", exitCode: null })).toMatchObject({ state: "warning" });
    expect(parseStatusValue({ phase: "exited", exitCode: 0 })).toMatchObject({ state: "healthy" });
    expect(parseStatusValue({ phase: "failed", exitCode: 1 })).toMatchObject({ state: "error" });
    expect(parseStatusValue({ ready: true })).toBeNull();
    expect(parseStatusValue({ state: "healthy", detail: 1 })).toBeNull();
  });

  test("requires the documented chart source shape", () => {
    expect(parseSourceChart({ labels: ["A", "B"], series: [{ label: "Builds", values: [1, null] }] }))
      .toEqual({ labels: ["A", "B"], series: [{ label: "Builds", values: [1, null] }] });
    expect(parseSourceChart({ values: [1, 2] })).toBeNull();
    expect(parseSourceChart({ labels: ["A"], series: [{ label: "Broken", values: ["1"] }] })).toBeNull();
  });
});
