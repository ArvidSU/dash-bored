import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type {
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResponsePayload,
  ImageReadPayload,
  ImageReadRequest,
  Permission,
  ShellRunRequest,
  ShellRunResult,
} from "../shared/contracts";
import { CoreError, errorMessage } from "./diagnostics";
import { resolveContainedPath, resolveUncontainedPath } from "./paths";

const DEFAULT_FILE_LIMIT = 1024 * 1024;
const DEFAULT_IMAGE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_HTTP_LIMIT = 2 * 1024 * 1024;
const DEFAULT_SHELL_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

const IMAGE_MEDIA_TYPES = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export function sniffImageMediaType(bytes: Uint8Array): (typeof IMAGE_MEDIA_TYPES)[number] | null {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (
    start < bytes.length &&
    (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)
  ) {
    start += 1;
  }
  const head = bytes.subarray(start, Math.min(bytes.length, start + 256));
  if (
    head.length > 5 &&
    head[0] === 0x3c &&
    (head[1] === 0x3f || head[1] === 0x73)
  ) {
    const probe = new TextDecoder("utf-8").decode(head);
    if (probe.includes("<svg")) return "image/svg+xml";
    return null;
  }
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface CapabilityContext {
  projectRoot: string;
  trusted: boolean;
  permissionsByNode: ReadonlyMap<string, ReadonlySet<Permission>>;
  projectRootsByNode?: ReadonlyMap<string, string>;
  /** Bundle directory per node; used to resolve dashboard-owned image paths. */
  configDirectoriesByNode?: ReadonlyMap<string, string>;
}

export interface CapabilityLimits {
  fileBytes?: number;
  imageBytes?: number;
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
  const bytes = await readBoundedBytes(
    stream,
    maximumBytes,
    overflowCode,
    `Output exceeded the ${maximumBytes}-byte limit.`,
  );
  return new TextDecoder().decode(bytes);
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  overflowCode: string,
  overflowMessage: string,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new CoreError(overflowCode, overflowMessage);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  private readonly imageBytes: number;
  private readonly httpResponseBytes: number;
  private readonly shellOutputBytes: number;
  private readonly maxTimeoutMs: number;

  constructor(context?: CapabilityContext, limits: CapabilityLimits = {}) {
    this.context = context ?? null;
    this.fileBytes = limits.fileBytes ?? DEFAULT_FILE_LIMIT;
    this.imageBytes = limits.imageBytes ?? DEFAULT_IMAGE_LIMIT;
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

  /** Resolve a trusted dashboard-level icon into a bounded, content-sniffed data URL. */
  async readImageWithLimits(
    request: ImageReadRequest,
    contextOverride: CapabilityContext,
  ): Promise<ImageReadPayload> {
    return this.readImageIn(request, contextOverride);
  }

  private async readImageIn(
    request: ImageReadRequest,
    context: CapabilityContext,
  ): Promise<ImageReadPayload> {
    if (!context.trusted) {
      throw new CoreError("PROJECT_UNTRUSTED", "Trust this project before using host capabilities.");
    }
    const source = request.source.trim();
    if (source === "") {
      throw new CoreError("IMAGE_SOURCE_INVALID", "The image source must be a non-empty path or HTTP(S) URL.");
    }
    const isHttp = /^https?:\/\//i.test(source);
    if (!isHttp && /^[a-z][a-z\d+.-]*:/i.test(source)) {
      throw new CoreError("HTTP_PROTOCOL_DENIED", "Only HTTP and HTTPS URLs are supported.");
    }

    let bytes: Uint8Array;
    if (isHttp) {
      bytes = await this.fetchImageBytes(source, request.timeoutMs);
    } else {
      const configDirectory =
        context.configDirectoriesByNode?.get(request.nodeId) ?? context.projectRoot;
      try {
        const path = await resolveUncontainedPath(configDirectory, source);
        const info = await stat(path);
        if (info.size > this.imageBytes) {
          throw new CoreError("IMAGE_TOO_LARGE", `Images may not exceed ${this.imageBytes} bytes.`);
        }
        bytes = await readFile(path);
      } catch (error) {
        if (error instanceof CoreError) throw error;
        const code = (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
          ? "IMAGE_NOT_FOUND"
          : "IMAGE_READ_FAILED";
        throw new CoreError(code, `Could not read the image: ${errorMessage(error)}`, { cause: error });
      }
    }

    if (bytes.byteLength > this.imageBytes) {
      throw new CoreError("IMAGE_TOO_LARGE", `Images may not exceed ${this.imageBytes} bytes.`);
    }
    const mediaType = sniffImageMediaType(bytes);
    if (mediaType === null) {
      throw new CoreError(
        "IMAGE_TYPE_UNSUPPORTED",
        "The image source is not a supported image type. Supported: SVG, PNG, JPEG, GIF, WebP.",
      );
    }
    return { dataUrl: toDataUrl(mediaType, bytes), mediaType };
  }

  private async fetchImageBytes(url: string, timeoutMs: number | undefined): Promise<Uint8Array> {
    const timeout = boundedTimeout(timeoutMs, this.maxTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal });
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") {
        throw new CoreError("HTTP_PROTOCOL_DENIED", "The HTTP redirect target is not allowed.");
      }
      if (!response.ok) {
        throw new CoreError("IMAGE_HTTP_STATUS", `The image request failed with HTTP status ${response.status}.`);
      }
      return await readBoundedBytes(
        response.body,
        this.imageBytes,
        "IMAGE_TOO_LARGE",
        `Images may not exceed ${this.imageBytes} bytes.`,
      );
    } catch (error) {
      if (controller.signal.aborted) throw new CoreError("HTTP_TIMEOUT", `HTTP request timed out after ${timeout}ms.`);
      if (error instanceof CoreError) throw error;
      throw new CoreError("HTTP_REQUEST_FAILED", errorMessage(error), { cause: error });
    } finally {
      clearTimeout(timer);
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
