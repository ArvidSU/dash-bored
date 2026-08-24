import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppSettingsStore } from "../../src/main/app-settings";
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from "../core/helpers";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

describe("AppSettingsStore", () => {
  test("uses the configured default and atomically persists an app-wide agent command", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const path = join(directory, "state", "settings-v1.json");
    const store = new AppSettingsStore(path, "codex exec");

    expect(await store.get()).toEqual({ dashBoredAgent: "codex exec" });
    expect(await store.update({ dashBoredAgent: "  claude -p  " })).toEqual({
      dashBoredAgent: "claude -p",
    });
    expect(await new AppSettingsStore(path, "ignored").get()).toEqual({
      dashBoredAgent: "claude -p",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      dashBoredAgent: "claude -p",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("falls back for corrupt state and rejects invalid updates without changing memory", async () => {
    const directory = await temporaryDirectory();
    cleanup.push(directory);
    const path = join(directory, "settings-v1.json");
    await writeFile(path, '{"version":1,"dashBoredAgent":""}\n');
    const store = new AppSettingsStore(path, "gemini -p");

    expect(await store.get()).toEqual({ dashBoredAgent: "gemini -p" });
    await expect(store.update({ dashBoredAgent: "" })).rejects.toMatchObject({
      code: "APP_SETTINGS_INVALID",
    });
    expect(await store.get()).toEqual({ dashBoredAgent: "gemini -p" });
  });
});
