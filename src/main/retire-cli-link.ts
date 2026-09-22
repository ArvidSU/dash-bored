import { lstat, readFile, readlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BUNDLED_TOOL_SUFFIX = "/Contents/Resources/app/tools/dash-bored";

/**
 * Earlier releases could link the bundled CLI into `~/.local/bin`. The CLI is
 * no longer a user-facing tool, so remove that link once, but only when its
 * receipt proves dash-bored created it and it still points at an app bundle.
 * Anything else at that path belongs to the user and is left untouched.
 */
export async function retireManagedCliLink(homeDirectory = homedir()): Promise<boolean> {
  const directory = join(homeDirectory, ".local", "bin");
  const linkPath = join(directory, "dash-bored");
  const receiptPath = join(directory, ".dash-bored-cli.json");
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { sourcePath?: unknown };
    if (typeof receipt.sourcePath !== "string") return false;
    if (!(await lstat(linkPath)).isSymbolicLink()) return false;
    const target = resolve(directory, await readlink(linkPath));
    if (target !== receipt.sourcePath || !target.endsWith(BUNDLED_TOOL_SUFFIX)) return false;
    await unlink(linkPath);
    await unlink(receiptPath);
    return true;
  } catch {
    return false;
  }
}
