import { describe, expect, test } from "bun:test";
import { APP_IDENTIFIER, APP_VERSION } from "../../src/shared/app-metadata";
import {
  assertReleaseTag,
  assertUpdateManifest,
  expectedReleaseTag,
} from "../../scripts/prepare-macos-release";

const archive = "canary-macos-arm64-dash-bored-canary.app.tar.zst";

function validManifest() {
  return {
    schemaVersion: 1,
    identifier: APP_IDENTIFIER,
    channel: "canary",
    version: APP_VERSION,
    platform: "macos",
    arch: "arm64",
    artifact: { file: archive },
  };
}

describe("macOS release contracts", () => {
  test("requires the tag to exactly match package.json", () => {
    expect(expectedReleaseTag()).toBe(`v${APP_VERSION}`);
    expect(() => assertReleaseTag(`v${APP_VERSION}`)).not.toThrow();
    expect(() => assertReleaseTag("v999.0.0")).toThrow("must exactly match package version");
  });

  test("accepts Electrobun metadata for the unsigned Apple Silicon canary", () => {
    expect(() => assertUpdateManifest(validManifest(), archive)).not.toThrow();
  });

  test("rejects worktree identifiers and non-macOS artifacts", () => {
    expect(() =>
      assertUpdateManifest({ ...validManifest(), identifier: "dev.dash-bored.wt-deadbeef" }, archive),
    ).toThrow("Unexpected update manifest identifier");
    expect(() =>
      assertUpdateManifest({ ...validManifest(), platform: "linux" }, archive),
    ).toThrow("Unexpected update manifest platform");
  });
});
