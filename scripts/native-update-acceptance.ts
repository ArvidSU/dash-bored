/** Opt-in genuine macOS update proof. Builds two isolated unsigned applications
 * with the production updater adapter and bundled CLI. Never updates the user's
 * installed application or grants macOS security approval. Keeps all evidence. */
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { BUNDLED_MIGRATIONS } from '../src/updates/releases';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This acceptance test requires Apple Silicon macOS.');
const source = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'dash-bored-native-update-'));
const checkout = join(root, 'source');
await mkdir(checkout);
const isolatedHutch = join(root, 'hutch');
const sharedHutch = process.env.HUTCH_HOME ?? join(homedir(), '.hutch');
for (const directory of ['releases', 'toolchains', 'npm']) await cp(join(sharedHutch, directory), join(isolatedHutch, directory), { recursive: true, filter: path => !path.endsWith('.lock') });
const identifier = `dev.dash-bored.update-test-${Date.now()}`;
console.log(`Native update acceptance evidence: ${root}`);
async function run(args: string[], cwd = checkout): Promise<string> {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, DASH_BORED_RELEASE: '1', HUTCH_HOME: isolatedHutch }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000);
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timeout);
  await writeFile(join(root, `command-${Date.now()}.log`), `${args.join(' ')}\n${out}\n${err}`);
  if (code !== 0) throw new Error(`${args.join(' ')} failed (${code}): ${err.slice(-3000)}\nEvidence: ${root}`);
  return out.trim();
}
const listing = await run(['git', 'ls-files', '-co', '--exclude-standard'], source);
for (const path of listing.split('\n').filter(Boolean)) {
  const target = join(checkout, path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(source, path), target, { recursive: true, dereference: false });
}
await symlink(join(source, 'node_modules'), join(checkout, 'node_modules'));
await mkdir(join(checkout, '.hutch'));
await cp(join(source, '.hutch/devkit'), join(checkout, '.hutch/devkit'), { recursive: true });
await cp(join(source, '.hutch/dependencies.lock'), join(checkout, '.hutch/dependencies.lock'));
await mkdir(join(checkout, 'dist/assets'), { recursive: true });
await writeFile(join(checkout, 'dist/index.html'), '<h1>dash-bored native update acceptance</h1>');
const metadataPath = join(checkout, 'src/shared/app-metadata.ts');
await writeFile(metadataPath, (await readFile(metadataPath, 'utf8')).replace('dev.dash-bored.app', identifier));
const configPath = join(checkout, 'electrobun.config.ts');
await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('src/main/index.ts', 'src/main/native-acceptance.ts'));
const targetDirectory = join(root, 'target');
const resultPath = join(root, 'result.json');
const targetMetadataPath = join(targetDirectory, 'dash-bored-release.json');
const proofMain = `
import { BrowserWindow, Updater, Utils } from 'electrobun/main';
import { join, resolve } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { APP_VERSION } from '../shared/app-metadata';
import { applyVerifiedNativeUpdate } from '../updates/native-updater';
const root = ${JSON.stringify(root)};
const metadata = JSON.parse(await readFile(${JSON.stringify(targetMetadataPath)}, 'utf8'));
const cli = resolve(import.meta.dirname, '../tools/dash-bored');
await writeFile(join(root, 'boot-' + APP_VERSION + '.json'), JSON.stringify({ version: APP_VERSION, pid: process.pid, cli, executable: process.execPath, local: await Updater.getLocalInfo() }));
new BrowserWindow({ title: 'dash-bored native update acceptance ' + APP_VERSION, url: 'views://mainview/index.html', frame: { width: 600, height: 300 } });
if (APP_VERSION === metadata.version) {
  const child = Bun.spawn([cli, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const version = (await new Response(child.stdout).text()).trim();
  const code = await child.exited;
  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ success: code === 0 && version === APP_VERSION, version: APP_VERSION, cliVersion: version, pid: process.pid }));
  setTimeout(() => Utils.quit(0), 1000);
} else {
  const attempted = join(root, 'attempted.json');
  if (await Bun.file(attempted).exists()) {
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ success: false, error: 'Native update relaunched the old version; inspect native result receipts.' }));
    Utils.quit(1);
  }
  await writeFile(attempted, JSON.stringify({ version: APP_VERSION }));
  setTimeout(() => { void (async () => {
    try {
      await applyVerifiedNativeUpdate(Updater, { format: 1, id: 'acceptance', release: { metadata, assetBase: 'https://github.com/ArvidSU/dash-bored/releases/download/v' + metadata.version + '/', url: 'https://github.com/ArvidSU/dash-bored/releases/tag/v' + metadata.version }, choice: 'update-only', selected: [], installation: 'ready', cancelled: false, migrations: {} }, root,
        (async url => new Response(Bun.file(join(${JSON.stringify(targetDirectory)}, new URL(String(url)).pathname.split('/').at(-1)!)))) as typeof fetch);
    } catch (error) { await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ success: false, error: String(error), history: Updater.getStatusHistory() })); Utils.quit(1); }
  })(); }, 1500);
}
`;
await writeFile(join(checkout, 'src/main/native-acceptance.ts'), proofMain);
const pkg = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
async function build(version: string, destination: string) {
  console.log(`Building isolated unsigned ${version}…`);
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2));
  await run(['bun', 'run', 'build:cli']);
  await run(['bun', 'node_modules/electrobun/bin/electrobun.cjs', 'build', '--env=canary']);
  await run(['bun', 'scripts/repair-macos-release-artifacts.ts']);
  await cp(join(checkout, 'build/canary-macos-arm64/dash-bored-canary.app'), destination, { recursive: true });
}
const installed = join(root, 'installed/dash-bored-canary.app');
await mkdir(dirname(installed), { recursive: true });
await build('99.0.1', installed);
await build('99.0.2', join(root, 'candidate/dash-bored-canary.app'));
await mkdir(targetDirectory);
for (const file of ['canary-macos-arm64-dash-bored-canary.app.tar.zst', 'canary-macos-arm64-update.json', 'canary-macos-arm64-dash-bored-canary.dmg']) await cp(join(checkout, 'artifacts', file), join(targetDirectory, file));
const digest = async (file: string) => createHash('sha256').update(await readFile(join(targetDirectory, file))).digest('hex');
const archive = 'canary-macos-arm64-dash-bored-canary.app.tar.zst';
const dmg = 'canary-macos-arm64-dash-bored-canary.dmg';
const updater = 'canary-macos-arm64-update.json';
await writeFile(targetMetadataPath, JSON.stringify({ format: 1, product: 'dash-bored', version: '99.0.2', channel: 'canary', platform: 'macos', arch: 'arm64', ...BUNDLED_MIGRATIONS, notes: 'Isolated native acceptance', archive: { file: archive, sha256: await digest(archive) }, dmg: { file: dmg, sha256: await digest(dmg) }, updater: { file: updater, sha256: await digest(updater) } }));
console.log('Launching old version and waiting for native replacement and new-version CLI proof…');
await run(['open', '-n', installed]);
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const result = await readFile(resultPath, 'utf8').catch(() => null);
  if (result) {
    console.log(result);
    const parsed = JSON.parse(result);
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ ...parsed, identifier, installed, targetDirectory, security: 'Locally built ad-hoc signed apps; no quarantine or OS approval bypass. Downloaded-DMG Gatekeeper approval is a separate manual check.' }, null, 2));
    if (!parsed.success) process.exitCode = 1;
    break;
  }
  await Bun.sleep(500);
}
if (!await Bun.file(resultPath).exists()) throw new Error(`Native update did not finish within 120 seconds. Inspect ${root}; no process was forcibly stopped.`);
// Native replacement can leave the disposable old launcher waiting after its
// Bun child exits. Stop only processes whose executable is in this test bundle.
const installedCanonical = await realpath(installed);
const processes = await run(['ps', '-axo', 'pid=,command=']);
for (const line of processes.split('\n')) {
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (match?.[2]?.startsWith(`${installedCanonical}/Contents/MacOS/`)) {
    try { process.kill(Number(match[1]), 'SIGTERM'); } catch { /* Already exited. */ }
  }
}
console.log(`Retained native update evidence: ${root}`);
