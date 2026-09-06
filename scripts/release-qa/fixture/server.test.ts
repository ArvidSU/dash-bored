import { expect, test } from "bun:test";
import { health } from "./server";
test("health response", async () => expect(await health().json()).toEqual({ ok: true }));
