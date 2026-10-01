import { isAbsolute, relative, sep } from "node:path";
import { CoreError } from "../core/diagnostics";

export const MAX_AGENT_DIFF_BYTES = 512 * 1024;

async function readBoundedProcessText(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<{ text: string; bytes: number }> {
  if (stream === null) return { text: "", bytes: 0 };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new CoreError("DASHBOARD_AGENT_DIFF_TOO_LARGE", "The dashboard diff exceeds the display limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), bytes: size };
}

async function runGit(
  projectRoot: string,
  args: string[],
  maximumBytes: number,
  allowedExitCodes = [0],
): Promise<{ text: string; bytes: number }> {
  const subprocess = Bun.spawn({
    cmd: ["git", "--literal-pathspecs", "-C", projectRoot, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      readBoundedProcessText(subprocess.stdout, maximumBytes),
      readBoundedProcessText(subprocess.stderr, MAX_AGENT_DIFF_BYTES),
    ]);
    if (subprocess.signalCode !== null || !allowedExitCodes.includes(exitCode)) {
      throw new CoreError(
        "DASHBOARD_AGENT_DIFF_FAILED",
        stderr.text.trim() || `git exited with code ${String(exitCode)}.`,
      );
    }
    return stdout;
  } catch (error) {
    if (subprocess.exitCode === null) subprocess.kill("SIGKILL");
    await subprocess.exited.catch(() => undefined);
    if (error instanceof CoreError) throw error;
    throw new CoreError("DASHBOARD_AGENT_DIFF_FAILED", error instanceof Error ? error.message : String(error));
  }
}

/** Read tracked and non-ignored new files without modifying the Git index. */
export async function readDashboardAgentDiff(projectRoot: string, configDirectory: string): Promise<string> {
  const folder = relative(projectRoot, configDirectory).split(sep).join("/");
  if (folder === "" || folder === ".." || folder.startsWith("../") || isAbsolute(folder)) {
    throw new CoreError("DASHBOARD_AGENT_DIFF_PATH_INVALID", "The dashboard folder is outside the project.");
  }

  const tracked = await runGit(projectRoot,
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", folder], MAX_AGENT_DIFF_BYTES);
  const untracked = await runGit(projectRoot,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", folder], MAX_AGENT_DIFF_BYTES);
  const patches = [tracked.text];
  let remainingBytes = MAX_AGENT_DIFF_BYTES - tracked.bytes;
  for (const path of untracked.text.split("\0").filter(Boolean)) {
    // --no-index treats symlinks as links and binary files as binary diffs.
    // Its exit code 1 means differences were found, rather than a failure.
    const patch = await runGit(projectRoot,
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", path],
      remainingBytes, [0, 1]);
    patches.push(patch.text);
    remainingBytes -= patch.bytes;
  }
  return patches.join("");
}
