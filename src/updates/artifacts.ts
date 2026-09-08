import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PublishedRelease } from "../shared/updates";
import { RELEASE_ASSET_BASE } from "./releases";

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function assertReleaseSource(release: PublishedRelease): void {
  if (release.url !== `https://github.com/ArvidSU/dash-bored/releases/tag/v${release.metadata.version}`) throw new Error("Release notes URL does not match the selected GitHub release.");
  if (release.assetBase !== `${RELEASE_ASSET_BASE}v${release.metadata.version}/`) throw new Error("Update source must be the selected version's GitHub HTTPS release.");
}
export async function downloadArtifact(release: PublishedRelease, kind: "dmg" | "archive" | "updater", directory: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  assertReleaseSource(release);
  const artifact = release.metadata[kind];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, artifact.file);
  if (await hashFile(target).catch(() => null) === artifact.sha256) return target;
  const temporary = `${target}.partial`;
  const response = await fetcher(`${release.assetBase}${artifact.file}`, { signal: signal ?? AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}. Retry download or use the release DMG.`);
  const file = await open(temporary, "w", 0o600);
  try {
    const reader = response.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 ** 3) { await reader.cancel(); throw new Error("Update artifact exceeds 4 GiB."); }
      let offset = 0;
      while (offset < value.length) offset += (await file.write(value, offset)).bytesWritten;
    }
    await file.sync();
    await file.close();
    if (await hashFile(temporary) !== artifact.sha256) throw new Error("SHA-256 mismatch. The artifact was rejected; retry the download.");
    await rename(temporary, target);
    return target;
  } finally { await file.close().catch(() => undefined); await rm(temporary, { force: true }); }
}
