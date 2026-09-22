import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_IDENTIFIER } from "../shared/app-metadata";
import type { UpdateReceipt } from "../shared/updates";

export function releaseAppDataDirectory(): string { return join(homedir(), 'Library', 'Application Support', APP_IDENTIFIER, 'canary'); }
export async function bundledInstallation(cliPath = process.execPath): Promise<{ cliPath: string; appPath: string }> {
  const actual = await realpath(cliPath);
  const suffix = '/Contents/Resources/app/tools/dash-bored';
  if (!actual.endsWith(suffix)) throw new Error('This is a source checkout or an independently copied tool. Install the release DMG manually; unified updates run from the installed app.');
  const appPath = actual.slice(0, -suffix.length);
  const info = JSON.parse(await readFile(join(appPath, 'Contents/Resources/version.json'), 'utf8'));
  if (info.identifier !== APP_IDENTIFIER || info.channel !== 'canary') throw new Error('Only the installed canary application supports unified updates.');
  return { cliPath: actual, appPath };
}
export async function openVerifiedDmg(receipt: UpdateReceipt): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Installation requires Apple Silicon macOS. Use the published DMG on a supported Mac.');
  if (!receipt.dmgPath) throw new Error('No verified DMG is staged.');
  const result = Bun.spawn(['open', receipt.dmgPath], { stdout: 'pipe', stderr: 'pipe' });
  if (await result.exited !== 0) throw new Error(`Could not open installer: ${await new Response(result.stderr).text()}. Open ${dirname(receipt.dmgPath)} in Finder and retry.`);
}
