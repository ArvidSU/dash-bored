import { describe, expect, test } from "bun:test";
import {
  appendEnvEntry,
  envEntries,
  invalidEnvLineCount,
  isValidEnvKey,
  parseEnv,
  removeEnvEntry,
  serializeEnv,
  updateEnvEntry,
} from "../../src/renderer/lib/env";

describe("env document editing", () => {
  test("parses common dotenv entries while preserving comments and raw lines", () => {
    const source = '# local values\nexport API_URL = "https://example.test"\nBROKEN\nTOKEN=abc # keep this note\n';
    const document = parseEnv(source);

    expect(envEntries(document).map(({ entry }) => [entry.key, entry.value])).toEqual([
      ["API_URL", "https://example.test"],
      ["TOKEN", "abc"],
    ]);
    expect(invalidEnvLineCount(document)).toBe(1);
    expect(serializeEnv(document)).toBe(source);
  });

  test("updates entries without dropping surrounding lines", () => {
    const document = parseEnv("# keep\nA=one\n\nRAW\nB=two");
    const updated = updateEnvEntry(document, 1, { value: "changed value" });

    expect(serializeEnv(updated)).toBe('# keep\nA="changed value"\n\nRAW\nB=two');
  });

  test("adds and removes rows and keeps the file newline style", () => {
    const document = parseEnv("A=one\r\n");
    const withNewRow = appendEnvEntry(document);
    const added = envEntries(withNewRow).at(-1);
    expect(added?.entry.key).toBe("DASH_BORED_AGENT");
    expect(serializeEnv(withNewRow)).toBe("A=one\r\nDASH_BORED_AGENT=\r\n");

    const removed = removeEnvEntry(withNewRow, added!.lineIndex);
    expect(serializeEnv(removed)).toBe("A=one\r\n");
  });

  test("adds the first row to an empty environment file", () => {
    const withFirstRow = appendEnvEntry(parseEnv(""));

    expect(envEntries(withFirstRow)).toHaveLength(1);
    expect(serializeEnv(withFirstRow)).toBe("DASH_BORED_AGENT=\n");
  });

  test("validates portable environment variable names", () => {
    expect(isValidEnvKey("DATABASE_URL")).toBeTrue();
    expect(isValidEnvKey("1_DATABASE_URL")).toBeFalse();
    expect(isValidEnvKey("DATABASE-URL")).toBeFalse();
  });
});
