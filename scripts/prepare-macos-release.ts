import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { APP_IDENTIFIER, APP_NAME, APP_VERSION } from "../src/shared/app-metadata";

interface UpdateManifest {
  schemaVersion?: unknown;
  identifier?: unknown;
  channel?: unknown;
  version?: unknown;
  platform?: unknown;
  arch?: unknown;
  artifact?: { file?: unknown };
}

const root = resolve(import.meta.dirname, "..");
const buildDirectory = join(root, "build", "canary-macos-arm64");
const artifactDirectory = join(root, "artifacts");
const outputDirectory = join(root, "release");
const appBundleName = `${APP_NAME}-canary.app`;
const sourceDmgName = `canary-macos-arm64-${APP_NAME}-canary.dmg`;
const updateArchiveName = `canary-macos-arm64-${APP_NAME}-canary.app.tar.zst`;
const updateManifestName = "canary-macos-arm64-update.json";

export function expectedReleaseTag(version = APP_VERSION): string {
  return `v${version}`;
}

export function assertReleaseTag(tag: string, version = APP_VERSION): void {
  const expected = expectedReleaseTag(version);
  if (tag !== expected) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must exactly match package version ${expected}.`);
  }
}

export function assertUpdateManifest(
  manifest: UpdateManifest,
  expectedArchive = updateArchiveName,
): void {
  const expected: Array<[string, unknown, unknown]> = [
    ["schemaVersion", manifest.schemaVersion, 1],
    ["identifier", manifest.identifier, APP_IDENTIFIER],
    ["channel", manifest.channel, "canary"],
    ["version", manifest.version, APP_VERSION],
    ["platform", manifest.platform, "macos"],
    ["arch", manifest.arch, "arm64"],
    ["artifact.file", manifest.artifact?.file, expectedArchive],
  ];
  for (const [field, actual, wanted] of expected) {
    if (actual !== wanted) {
      throw new Error(
        `Unexpected update manifest ${field}: expected ${JSON.stringify(wanted)}, received ${JSON.stringify(actual)}.`,
      );
    }
  }
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: command,
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited with code ${exitCode}: ${(stderr || stdout).trim()}`,
    );
  }
  return stdout.trim();
}

async function requireFile(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required release file is missing: ${path}`);
}

async function plistValue(appPath: string, key: string): Promise<string> {
  return run([
    "plutil",
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    join(appPath, "Contents", "Info.plist"),
  ]);
}

async function verifyAppBundle(appPath: string): Promise<void> {
  await run(["codesign", "--verify", "--deep", "--strict", appPath]).catch((error: unknown) => {
    throw new Error(
      `Packaged app has an invalid code signature; rebuild with bun run build:release: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  const [version, identifier, name, iconFile, launcherArchitecture] = await Promise.all([
    plistValue(appPath, "CFBundleVersion"),
    plistValue(appPath, "CFBundleIdentifier"),
    plistValue(appPath, "CFBundleName"),
    plistValue(appPath, "CFBundleIconFile"),
    run(["file", join(appPath, "Contents", "MacOS", "launcher")]),
  ]);
  if (version !== APP_VERSION) {
    throw new Error(`Packaged app version ${version} does not match package version ${APP_VERSION}.`);
  }
  if (identifier !== APP_IDENTIFIER) {
    throw new Error(
      `Packaged app identifier ${identifier} is not the release identifier ${APP_IDENTIFIER}; rebuild with bun run build:release.`,
    );
  }
  if (name !== `${APP_NAME}-canary`) {
    throw new Error(`Unexpected packaged app name: ${name}.`);
  }
  if (iconFile !== "AppIcon") {
    throw new Error(`Unexpected packaged app icon metadata: ${iconFile}.`);
  }
  await requireFile(join(appPath, "Contents", "Resources", "AppIcon.icns"));
  if (!launcherArchitecture.includes("arm64")) {
    throw new Error(`Packaged launcher is not arm64: ${launcherArchitecture}.`);
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function releaseNotes(tag: string, dmgName: string): string {
  return `# dash-bored ${tag}

Unsigned macOS prerelease for **Apple Silicon** on **macOS 14 or newer**.

## Install

1. Download \`${dmgName}\` and \`SHA256SUMS.txt\`.
2. Optionally verify the download with \`shasum -a 256 -c SHA256SUMS.txt\`.
3. Open the DMG and drag **dash-bored-canary** to **Applications**.
4. Try to open the app. Because this prerelease is not signed or notarized, macOS may block the first launch.
5. If blocked, open **System Settings → Privacy & Security**, select **Open Anyway**, and confirm.

The desktop app already contains its matching \`dash-bored\` CLI; Bun is not required. You can expose the CLI to external shells later from the starter dashboard.

Signing, notarization, automatic updates, Linux, Windows, and Intel Mac builds are intentionally deferred.
`;
}

function requestedTag(args: string[]): string {
  const tagIndex = args.indexOf("--tag");
  if (tagIndex === -1) {
    if (args.length > 0) throw new Error("release:prepare accepts only --tag <version-tag>.");
    return expectedReleaseTag();
  }
  const tag = args[tagIndex + 1];
  if (!tag || tag.startsWith("-")) throw new Error("--tag requires a version tag.");
  if (args.length !== 2) throw new Error("release:prepare accepts only --tag <version-tag>.");
  return tag;
}

async function prepare(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS release preparation must run on an Apple Silicon macOS host.");
  }

  const tag = requestedTag(process.argv.slice(2));
  assertReleaseTag(tag);

  const sourceDmg = join(artifactDirectory, sourceDmgName);
  const updateArchive = join(artifactDirectory, updateArchiveName);
  const updateManifestPath = join(artifactDirectory, updateManifestName);
  await Promise.all([
    requireFile(sourceDmg),
    requireFile(updateArchive),
    requireFile(updateManifestPath),
    verifyAppBundle(join(buildDirectory, appBundleName)),
  ]);

  const updateManifest = JSON.parse(await readFile(updateManifestPath, "utf8")) as UpdateManifest;
  assertUpdateManifest(updateManifest);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dash-bored-release-"));
  const mountedDmg = join(temporaryDirectory, "dmg");
  let mounted = false;
  try {
    const extractedDirectory = join(temporaryDirectory, "extracted");
    await Promise.all([mkdir(mountedDmg), mkdir(extractedDirectory)]);
    await run(["tar", "-xf", updateArchive, "-C", extractedDirectory]);
    const extractedApp = join(extractedDirectory, appBundleName);
    await verifyAppBundle(extractedApp);
    const bundledCli = join(extractedApp, "Contents", "Resources", "app", "tools", APP_NAME);
    await requireFile(bundledCli);
    const cliVersion = await run([bundledCli, "--version"]);
    if (cliVersion !== APP_VERSION) {
      throw new Error(`Bundled CLI version ${cliVersion} does not match package version ${APP_VERSION}.`);
    }

    await run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mountedDmg, sourceDmg]);
    mounted = true;
    await verifyAppBundle(join(mountedDmg, appBundleName));
    const applicationsLink = await lstat(join(mountedDmg, "Applications")).catch(() => null);
    if (!applicationsLink?.isSymbolicLink()) {
      throw new Error("The release DMG does not contain the Applications shortcut.");
    }
  } finally {
    if (mounted) await run(["hdiutil", "detach", mountedDmg]).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory);
  const releaseDmgName = `${APP_NAME}-${tag}-macos-arm64-unsigned.dmg`;
  const releaseDmg = join(outputDirectory, releaseDmgName);
  await copyFile(sourceDmg, releaseDmg);
  await writeFile(
    join(outputDirectory, "SHA256SUMS.txt"),
    `${await sha256(releaseDmg)}  ${releaseDmgName}\n`,
    "utf8",
  );
  await writeFile(join(outputDirectory, "RELEASE_NOTES.md"), releaseNotes(tag, releaseDmgName), "utf8");

  console.log(`Prepared verified macOS release assets in ${outputDirectory}:`);
  console.log(`- ${basename(releaseDmg)}`);
  console.log("- SHA256SUMS.txt");
  console.log("- RELEASE_NOTES.md");
}

if (import.meta.main) {
  await prepare().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
