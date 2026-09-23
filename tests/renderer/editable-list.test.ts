import { expect, test } from "bun:test";
import Ajv from "ajv";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getBuiltinManifest } from "../../src/core/builtins";
import List from "../../src/renderer/builtins/list";
import type { LocalComponentHost } from "../../src/shared/contracts";

test("list accepts stable-ID editable todos and renders them without a shell source", () => {
  const schema = getBuiltinManifest("@dash-bored/list")?.propsSchema;
  if (!schema) throw new Error("missing list manifest");
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
  const item = { id: "task-1", description: "Prove editable list", done: false, tags: ["atoms"] };
  expect(validate({ todos: [item] })).toBeTrue();
  expect(validate({ todos: [{ ...item, id: undefined }] })).toBeFalse();
  expect(validate({ todos: [item], source: { inline: [] } })).toBeFalse();

  const html = renderToStaticMarkup(createElement(List, {
    props: { todos: [item] },
    host: {} as LocalComponentHost,
  }));
  expect(html).toContain("Prove editable list");
  expect(html).not.toContain("List needs a source");
});
