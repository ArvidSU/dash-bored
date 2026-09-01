import { describe, expect, test } from "bun:test";
import { conditionalVisibility, shellConditionSucceeded } from "../../src/renderer/builtins/conditional";

describe("conditional visibility", () => {
  test("only treats a clean zero exit as a successful condition", () => {
    expect(shellConditionSucceeded({ exitCode: 0, signal: null, timedOut: false })).toBeTrue();
    expect(shellConditionSucceeded({ exitCode: 1, signal: null, timedOut: false })).toBeFalse();
    expect(shellConditionSucceeded({ exitCode: 0, signal: "SIGTERM", timedOut: false })).toBeFalse();
    expect(shellConditionSucceeded({ exitCode: null, signal: "SIGTERM", timedOut: true })).toBeFalse();
  });

  test("supports showing on either side of the condition", () => {
    const success = { exitCode: 0, signal: null, timedOut: false } as const;
    const failure = { exitCode: 1, signal: null, timedOut: false } as const;

    expect(conditionalVisibility(success, false)).toBeTrue();
    expect(conditionalVisibility(failure, false)).toBeFalse();
    expect(conditionalVisibility(success, true)).toBeFalse();
    expect(conditionalVisibility(failure, true)).toBeTrue();
  });
});
