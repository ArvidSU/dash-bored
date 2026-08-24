import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type {
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  Permission,
  ShellRunRequest,
  ShellRunResult,
} from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import { resolveContainedPath } from "./paths";

const DEFAULT_FILE_LIMIT = 1024 * 1024;
const DEFAULT_HTTP_LIMIT = 2 * 1024 * 1024;
const DEFAULT_SHELL_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

export interface CapabilityContext {
  projectRoot: string;
  trusted: boolean;
  permissionsByNode: ReadonlyMap<string, ReadonlySet<Permission>>;
  projectRootsByNode?: ReadonlyMap<string, string>;
}

export interface CapabilityLimits {
  fileBytes?: number;
  httpResponseBytes?: number;
  shellOutputBytes?: number;
  maxTimeoutMs?: number;
}

function boundedTimeout(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return Math.min(DEFAULT_TIMEOUT_MS, maximum);
  if (!Number.isFinite(requested) || requested <= 0 || requested > maximum) {
    throw new CoreError("TIMEOUT_INVALID", `Timeout must be between 1 and ${maximum} milliseconds.`);
  }
  return Math.floor(requested);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  overflowCode: string,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new CoreError(overflowCode, `Output exceeded the ${maximumBytes}-byte limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function terminateTree(subprocess: Bun.Subprocess, signal: NodeJS.Signals): Promise<void> {
  if (subprocess.exitCode !== null) return;
  if (process.platform === "win32") {
    const args = ["taskkill", "/PID", String(subprocess.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    await Bun.spawn({ cmd: args, stdout: "ignore", stderr: "ignore" }).exited.catch(() => undefined);
    return;
  }
  try {
    process.kill(-subprocess.pid, signal);
  } catch {
    try {
      subprocess.kill(signal);
    } catch {
      // It may have exited between the checks.
    }
  }
}

export class CapabilityService {
  private context: CapabilityContext | null = null;
  private readonly fileBytes: number;
  private readonly httpResponseBytes: number;
  private readonly shellOutputBytes: number;
  private readonly maxTimeoutMs: number;

  constructor(context?: CapabilityContext, limits: CapabilityLimits = {}) {
    this.context = context ?? null;
    this.fileBytes = limits.fileBytes ?? DEFAULT_FILE_LIMIT;
    this.httpResponseBytes = limits.httpResponseBytes ?? DEFAULT_HTTP_LIMIT;
    this.shellOutputBytes = limits.shellOutputBytes ?? DEFAULT_SHELL_LIMIT;
    this.maxTimeoutMs = limits.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  }

  configure(context: CapabilityContext | null): void {
    this.context = context;
  }

  assertAllowed(nodeId: string, permission: Permission): CapabilityContext {
    const context = this.context;
    if (context === null) throw new CoreError("PROJECT_NOT_LOADED", "No project is loaded.");
    if (!context.trusted) throw new CoreError("PROJECT_UNTRUSTED", "Trust this project before using host capabilities.");
    const permissions = context.permissionsByNode.get(nodeId);
    if (permissions === undefined) throw new CoreError("NODE_NOT_FOUND", `Unknown dashboard node: ${nodeId}`);
    if (!permissions.has(permission)) {
      throw new CoreError(
        "PERMISSION_DENIED",
        `Dashboard node ${nodeId} did not declare ${permission}.`,
      );
    }
    return context;
  }

  async readText(request: FileReadRequest): Promise<string> {
    const context = this.assertAllowed(request.nodeId, "filesystem:read");
    const projectRoot = context.projectRootsByNode?.get(request.nodeId) ?? context.projectRoot;
    const path = await resolveContainedPath(projectRoot, request.path, { kind: "file" });
    const info = await stat(path);
    if (info.size > this.fileBytes) {
      throw new CoreError("FILE_TOO_LARGE", `Files may not exceed ${this.fileBytes} bytes.`);
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > this.fileBytes) {
      throw new CoreError("FILE_TOO_LARGE", `Files may not exceed ${this.fileBytes} bytes.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CoreError("FILE_NOT_UTF8", "The requested file is not valid UTF-8 text.");
    }
  }

  async writeText(request: FileWriteRequest): Promise<void> {
    const context = this.assertAllowed(request.nodeId, "filesystem:write");
    if (Buffer.byteLength(request.content, "utf8") > this.fileBytes) {
      throw new CoreError("FILE_TOO_LARGE", `Files may not exceed ${this.fileBytes} bytes.`);
    }
    const projectRoot = context.projectRootsByNode?.get(request.nodeId) ?? context.projectRoot;
    const path = await resolveContainedPath(projectRoot, request.path, {
      kind: "file",
      mustExist: false,
    });
    let mode = 0o600;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, request.content, { encoding: "utf8", mode });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new CoreError("FILE_WRITE_FAILED", errorMessage(error), { cause: error });
    }
  }

  async http(request: HttpRequest): Promise<HttpResponsePayload> {
    this.assertAllowed(request.nodeId, "network:http");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new CoreError("HTTP_URL_INVALID", "HTTP requests require an absolute URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new CoreError("HTTP_PROTOCOL_DENIED", "Only HTTP and HTTPS URLs are supported.");
    }
    const method = (request.method ?? "GET").toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new CoreError("HTTP_METHOD_INVALID", "Invalid HTTP method.");
    if (Buffer.byteLength(request.body ?? "", "utf8") > this.httpResponseBytes) {
      throw new CoreError("HTTP_BODY_TOO_LARGE", "The HTTP request body is too large.");
    }

    const timeout = boundedTimeout(request.timeoutMs, this.maxTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers: request.headers,
        body: request.body,
        redirect: "follow",
        signal: controller.signal,
      });
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") {
        throw new CoreError("HTTP_PROTOCOL_DENIED", "The HTTP redirect target is not allowed.");
      }
      const body = await readBoundedStream(response.body, this.httpResponseBytes, "HTTP_RESPONSE_TOO_LARGE");
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new CoreError("HTTP_TIMEOUT", `HTTP request timed out after ${timeout}ms.`);
      if (error instanceof CoreError) throw error;
      throw new CoreError("HTTP_REQUEST_FAILED", errorMessage(error), { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async runShell(request: ShellRunRequest): Promise<ShellRunResult> {
    const context = this.assertAllowed(request.nodeId, "process:execute");
    const projectRoot = context.projectRootsByNode?.get(request.nodeId) ?? context.projectRoot;
    if (request.command.trim() === "" || request.command.length > 32_768) {
      throw new CoreError("SHELL_COMMAND_INVALID", "Shell command must be non-empty and at most 32768 characters.");
    }
    const cwd =
      request.cwd === undefined
        ? projectRoot
        : await resolveContainedPath(projectRoot, request.cwd, { kind: "directory" });
    const timeout = boundedTimeout(request.timeoutMs, this.maxTimeoutMs);
    const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["/bin/sh", "-lc"];
    const subprocess = Bun.spawn({
      cmd: [...shell, request.command],
      cwd,
      env: { ...process.env, ...request.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateTree(subprocess, "SIGTERM");
      setTimeout(() => void terminateTree(subprocess, "SIGKILL"), 1_000);
    }, timeout);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        readBoundedStream(subprocess.stdout, this.shellOutputBytes, "SHELL_OUTPUT_TOO_LARGE"),
        readBoundedStream(subprocess.stderr, this.shellOutputBytes, "SHELL_OUTPUT_TOO_LARGE"),
      ]);
      return {
        exitCode: subprocess.signalCode === null ? exitCode : null,
        signal: subprocess.signalCode,
        stdout,
        stderr,
        timedOut,
      };
    } catch (error) {
      await terminateTree(subprocess, "SIGKILL");
      if (error instanceof CoreError) throw error;
      throw new CoreError("SHELL_RUN_FAILED", errorMessage(error), { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
