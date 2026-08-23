import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityService, CoreError, TrustStore } from "../../src/core";
import type { Permission } from "../../src/shared/contracts";
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from "./helpers";

const cleanup: string[] = [];
const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(cleanup.splice(0).map(removeTemporaryDirectory));
});

describe("TrustStore", () => {
  test("persists grants, requires reapproval for expanded permissions, and revokes", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const store = new TrustStore(join(root, "state", "trust.json"));

    expect(await store.isTrusted(root, [])).toBeFalse();
    await store.trust(root, ["filesystem:read"]);
    expect(await store.isTrusted(root, [])).toBeTrue();
    expect(await store.isTrusted(root, ["filesystem:read"])).toBeTrue();
    expect(await store.isTrusted(root, ["filesystem:read", "network:http"])).toBeFalse();
    expect(await store.revoke(root)).toBeTrue();
    expect(await store.isTrusted(root, [])).toBeFalse();
  });
});

function service(
  root: string,
  permission: Permission,
  limits: ConstructorParameters<typeof CapabilityService>[1] = {},
): CapabilityService {
  return new CapabilityService(
    {
      projectRoot: root,
      trusted: true,
      permissionsByNode: new Map([["node", new Set([permission])]]),
    },
    limits,
  );
}

describe("CapabilityService", () => {
  test("enforces trust, declarations, containment, UTF-8, and actual file size", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await writeFile(join(root, "small.txt"), "hello");
    await writeFile(join(root, "large.txt"), "123456789");
    await writeFile(join(root, "binary.txt"), Uint8Array.from([0xff, 0xfe]));

    const files = service(root, "filesystem:read", { fileBytes: 8 });
    expect(await files.readText({ nodeId: "node", path: "small.txt" })).toBe("hello");
    await expect(files.readText({ nodeId: "node", path: "../outside" })).rejects.toMatchObject({
      code: "PATH_OUTSIDE_PROJECT",
    });
    await expect(files.readText({ nodeId: "node", path: "large.txt" })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(files.readText({ nodeId: "node", path: "binary.txt" })).rejects.toMatchObject({
      code: "FILE_NOT_UTF8",
    });

    files.configure({ projectRoot: root, trusted: false, permissionsByNode: new Map() });
    await expect(files.readText({ nodeId: "node", path: "small.txt" })).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
    });
  });

  test("bounds HTTP protocols, response bytes, and timeouts", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    const server = Bun.serve({
      port: 0,
      routes: {
        "/ok": () => new Response("hello", { headers: { "x-test": "yes" } }),
        "/large": () => new Response("123456789"),
      },
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response("slow");
      },
    });
    servers.push(server);
    const http = service(root, "network:http", { httpResponseBytes: 8, maxTimeoutMs: 100 });
    const base = `http://127.0.0.1:${server.port}`;

    const response = await http.http({ nodeId: "node", url: `${base}/ok` });
    expect(response.body).toBe("hello");
    expect(response.headers["x-test"]).toBe("yes");
    await expect(http.http({ nodeId: "node", url: "file:///tmp/a" })).rejects.toMatchObject({
      code: "HTTP_PROTOCOL_DENIED",
    });
    await expect(http.http({ nodeId: "node", url: `${base}/large` })).rejects.toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
    });
    await expect(
      http.http({ nodeId: "node", url: `${base}/slow`, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "HTTP_TIMEOUT" });
  });

  test("runs bounded short shell commands within the project", async () => {
    const root = await temporaryDirectory();
    cleanup.push(root);
    await mkdir(join(root, "sub"));
    const shell = service(root, "process:execute", { shellOutputBytes: 64, maxTimeoutMs: 100 });

    const result = await shell.runShell({
      nodeId: "node",
      command: "printf 'hello'; printf 'warning' >&2",
      cwd: "sub",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "hello", stderr: "warning", timedOut: false });
    const timeout = await shell.runShell({ nodeId: "node", command: "sleep 1", timeoutMs: 20 });
    expect(timeout.timedOut).toBeTrue();
    expect(timeout.signal).not.toBeNull();
  });

  test("uses stable capability error codes", () => {
    const error = new CoreError("EXAMPLE", "message");
    expect(error.code).toBe("EXAMPLE");
    expect(error.message).toBe("message");
  });
});
