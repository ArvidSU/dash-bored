import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME } from "../src/shared/app-metadata";

const root = resolve(import.meta.dirname, "..");
const buildDirectory = join(root, "build", "canary-macos-arm64");
const artifactDirectory = join(root, "artifacts");
const appBundleName = `${APP_NAME}-canary.app`;
const appPath = join(buildDirectory, appBundleName);
const dmgPath = join(artifactDirectory, `canary-macos-arm64-${APP_NAME}-canary.dmg`);
const updateArchivePath = join(
  artifactDirectory,
  `canary-macos-arm64-${APP_NAME}-canary.app.tar.zst`,
);

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

async function requireDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Required app bundle is missing: ${path}`);
}

export async function verifyAdHocBundleSignature(path = appPath): Promise<void> {
  await run(["codesign", "--verify", "--deep", "--strict", path]);
}

async function repair(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS release artifact repair must run on an Apple Silicon macOS host.");
  }

  await requireDirectory(appPath);
  await mkdir(artifactDirectory, { recursive: true });

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dash-bored-release-artifacts-"));
  const stagingDirectory = join(temporaryDirectory, "dmg");
  const updateExtractionDirectory = join(temporaryDirectory, "update");
  const temporaryArchive = join(temporaryDirectory, `${appBundleName}.tar`);
  try {
    await Promise.all([mkdir(stagingDirectory), mkdir(updateExtractionDirectory)]);

    // Electrobun's launcher is linker-signed, but the enclosing app bundle is
    // otherwise unsigned. Seal the bundle ad hoc so Gatekeeper sees a valid
    // unsigned app and can offer the normal explicit user override.
    await run(["codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
    await verifyAdHocBundleSignature();

    await cp(appPath, join(stagingDirectory, appBundleName), { recursive: true });
    await symlink("/Applications", join(stagingDirectory, "Applications"));
    await run([
      "hdiutil",
      "create",
      "-volname",
      `${APP_NAME}-canary`,
      "-srcfolder",
      stagingDirectory,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ]);

    // The update archive contains Electrobun's expanded app, not the compact
    // self-extracting wrapper used by the DMG. Sign and repack that payload
    // separately so both distribution paths have valid bundle signatures.
    await run(["tar", "-xf", updateArchivePath, "-C", updateExtractionDirectory]);
    const expandedAppPath = join(updateExtractionDirectory, appBundleName);
    await requireDirectory(expandedAppPath);
    await run([
      "codesign",
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      expandedAppPath,
    ]);
    await verifyAdHocBundleSignature(expandedAppPath);

    await run(["tar", "-cf", temporaryArchive, "-C", updateExtractionDirectory, appBundleName]);
    await run(["zstd", "-q", "-f", temporaryArchive, "-o", updateArchivePath]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(`Repaired signed macOS release artifacts in ${artifactDirectory}.`);
}

if (import.meta.main) {
  await repair().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
