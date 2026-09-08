import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_IDENTIFIER } from "../shared/app-metadata";
import type { UpdateReceipt } from "../shared/updates";
import { readJson } from "./storage";

export function releaseAppDataDirectory(): string { return join(homedir(), 'Library', 'Application Support', APP_IDENTIFIER, 'canary'); }
export async function bundledInstallation(cliPath = process.execPath): Promise<{ cliPath: string; appPath: string }> {
  const actual = await realpath(cliPath);
  const suffix = '/Contents/Resources/app/tools/dash-bored';
  if (!actual.endsWith(suffix)) throw new Error('This is a source checkout or independently copied CLI. Install the release DMG manually; use its bundled CLI or a managed shell link for unified updates.');
  const appPath = actual.slice(0, -suffix.length);
  const info = JSON.parse(await readFile(join(appPath, 'Contents/Resources/version.json'), 'utf8'));
  if (info.identifier !== APP_IDENTIFIER || info.channel !== 'canary') throw new Error('Only the installed canary application supports unified updates.');
  return { cliPath: actual, appPath };
}
export async function assertNoRunningApp(directory: string): Promise<void> {
  const marker = await readJson(join(directory, 'app-host.json')) as { pid?: number } | null;
  if (!marker?.pid || marker.pid === process.pid) return;
  try { process.kill(marker.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
  throw new Error('dash-bored is running. Finish running work and save or cancel its drafts, then use Updates in the app or quit it before installing from the CLI.');
}
export async function openVerifiedDmg(receipt: UpdateReceipt): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Installation requires Apple Silicon macOS. Use the published DMG on a supported Mac.');
  if (!receipt.dmgPath) throw new Error('No verified DMG is staged.');
  const result = Bun.spawn(['open', receipt.dmgPath], { stdout: 'pipe', stderr: 'pipe' });
  if (await result.exited !== 0) throw new Error(`Could not open installer: ${await new Response(result.stderr).text()}. Open ${dirname(receipt.dmgPath)} in Finder and retry.`);
}
