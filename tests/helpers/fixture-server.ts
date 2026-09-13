interface FixtureServerOptions {
  cmd: string[];
  url: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  outputLimit?: number;
  shutdownTimeoutMs?: number;
}

export interface FixtureServer {
  readonly pid: number;
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

function captureOutput(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let truncated = false;
  const append = (text: string) => {
    tail += text;
    if (tail.length > limit) {
      truncated = true;
      tail = tail.slice(-limit);
    }
  };
  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
      append(decoder.decode());
    } catch (error) {
      append(`\n[Could not read process output: ${String(error)}]`);
    }
  })();
  return {
    done,
    text: () => `${truncated ? "[earlier output omitted]\n" : ""}${tail || "(no output)"}`,
    cancel: () => { void reader.cancel().catch(() => {}); },
  };
}

async function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns only the child it spawns; never attaches to or kills a process by port. */
export function startFixtureServer(options: FixtureServerOptions): FixtureServer {
  const {
    url, timeoutMs = 8_000, requestTimeoutMs = 1_000, pollIntervalMs = 100,
    outputLimit = 8_192, shutdownTimeoutMs = 500,
  } = options;
  const child = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = captureOutput(child.stdout, outputLimit);
  const stderr = captureOutput(child.stderr, outputLimit);
  const outputDone = Promise.all([stdout.done, stderr.done]);
  const exited = child.exited.then((code) => ({ kind: "exit" as const, code }));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        if (!await waitAtMost(child.exited, shutdownTimeoutMs)) {
          child.kill("SIGKILL");
          if (!await waitAtMost(child.exited, shutdownTimeoutMs)) {
            throw new Error(`Renderer fixture process ${child.pid} did not exit after SIGKILL.`);
          }
        }
      }
      await waitAtMost(outputDone, 100);
    } finally {
      stdout.cancel();
      stderr.cancel();
    }
  })();

  const ready = (async () => {
    const deadline = performance.now() + timeoutMs;
    let lastProbe = "No HTTP response received.";
    try {
      while (performance.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Renderer fixture exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode ?? "none"}).`);
        }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            fetch(url, { signal: controller.signal, redirect: "error" }).then((response) => {
              void response.body?.cancel().catch(() => {});
              return { kind: "probe" as const, ok: response.ok, detail: `HTTP ${response.status} ${response.statusText}`.trim() };
            }).catch((error: unknown) => ({ kind: "probe" as const, ok: false, detail: String(error) })),
            exited,
            new Promise<{ kind: "probe"; ok: false; detail: string }>((resolve) => {
              timer = setTimeout(() => resolve({ kind: "probe", ok: false, detail: "HTTP probe timed out." }),
                Math.max(1, Math.min(requestTimeoutMs, deadline - performance.now())));
            }),
          ]);
          if (result.kind === "exit") {
            throw new Error(`Renderer fixture exited before becoming ready (code ${result.code}, signal ${child.signalCode ?? "none"}).`);
          }
          if (result.ok && child.exitCode === null && child.signalCode === null) return;
          lastProbe = result.detail;
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        await waitAtMost(exited, Math.max(1, Math.min(pollIntervalMs, deadline - performance.now())));
      }
      throw new Error(`Renderer fixture did not become ready within ${timeoutMs} ms. Last probe: ${lastProbe}`);
    } catch (error) {
      let cleanupFailure = "";
      try {
        await stop();
      } catch (cleanupError) {
        cleanupFailure = `\nCleanup failed: ${String(cleanupError)}`;
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nURL: ${url}\nProcess: ${child.pid}\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}${cleanupFailure}`);
    }
  })();
  return { pid: child.pid, ready, stop };
}
