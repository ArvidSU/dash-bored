import { afterEach, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { compileJsonSchema } from "../../src/core/json-schema";
import { parseComponentManifest, validatePropsSchema } from "../../src/core/yaml";
import { COMPONENT_API_VERSION } from "../../src/shared/component-api";
import { removeTemporaryDirectory, temporaryDirectory } from "./helpers";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(removeTemporaryDirectory)));

test("reuses parsed schema content and evicts old validators when schemas change", () => {
  const schema = { type: "object", properties: { cacheProbe: { type: "string" } } };
  const first = compileJsonSchema(schema);
  expect(compileJsonSchema(structuredClone(schema))).toBe(first);
  for (let index = 0; index < 256; index++) {
    compileJsonSchema({ type: "object", properties: { [`field${index}`]: { type: "number" } } });
  }
  expect(compileJsonSchema(schema)).not.toBe(first);
  expect(first({ cacheProbe: 1 })).toBeFalse();
});

test("repeated prop validation does not retain each freshly parsed schema", () => {
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
  for (let index = 0; index < 100; index++) validatePropsSchema(structuredClone(schema), { value: "ok" });
  Bun.gc(true);
  const before = heapStats().heapSize;
  for (let index = 0; index < 1000; index++) {
    expect(validatePropsSchema(structuredClone(schema), { value: "ok" })).toEqual([]);
  }
  Bun.gc(true);
  // The old object-identity cache retained over 6 MB for these 1,000 loads.
  expect(heapStats().heapSize - before).toBeLessThan(1024 * 1024);
  expect(validatePropsSchema(schema, { value: 1 })[0]?.keyword).toBe("type");
});

test("schema edits do not accumulate in Ajv's generated-code scope after cache eviction", () => {
  let next = 0;
  const compileBatch = () => {
    for (const end = next + 1024; next < end; next++) {
      compileJsonSchema({ type: "object", properties: { [`edit${next}`]: { type: "string" } } });
    }
    Bun.gc(true);
    return heapStats().heapSize;
  };
  const growth = () => {
    const before = compileBatch();
    compileBatch();
    return compileBatch() - before;
  };
  // Other suites' background work in the shared test process only adds heap
  // noise, so the smallest of several samples isolates Ajv's own retention.
  // Removing schema registrations alone still retained about 6 MB per sample.
  expect(Math.min(growth(), growth(), growth())).toBeLessThan(1024 * 1024);
});

test("manifest reloads release both props and child metadata schema registrations", async () => {
  const root = await temporaryDirectory();
  directories.push(root);
  const file = join(root, "component.yaml");
  const manifest = {
    schemaVersion: 3, apiVersion: COMPONENT_API_VERSION, id: "schema-cache-probe", name: "Probe",
    description: "Schema cache probe", entry: "./index.tsx",
    propsSchema: { $id: "urn:dash-bored:test:props", type: "object" },
    children: { presentation: { type: "managed" }, min: 0, metadataSchema: { $id: "urn:dash-bored:test:metadata", type: "object" } },
  };
  await writeFile(file, stringify(manifest));
  for (let index = 0; index < 3; index++) {
    const result = await parseComponentManifest(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).not.toBeNull();
  }
});

test("failed compilation releases its schema ID and local references still validate", () => {
  expect(() => compileJsonSchema({ $id: "urn:dash-bored:test:retry", type: "invalid" })).toThrow();
  const validate = compileJsonSchema({
    $id: "urn:dash-bored:test:retry", type: "object",
    definitions: { name: { type: "string" } }, properties: { name: { $ref: "#/definitions/name" } },
  });
  expect(validate({ name: "ok" })).toBeTrue();
  expect(validate({ name: 1 })).toBeFalse();
});
