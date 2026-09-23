import { emit } from "./lib/run";

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets?: Array<{ name: string; download_count: number }>;
}

export interface ReleaseListItem {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  state: string;
  tag: string;
}

export function releaseListItems(releases: GitHubRelease[]): ReleaseListItem[] {
  return releases.map((release) => {
    const channel = release.draft ? "draft" : release.prerelease ? "prerelease" : "stable";
    const downloads = (release.assets ?? []).reduce((total, asset) => total + asset.download_count, 0);
    const published = release.published_at ? release.published_at.slice(0, 10) : "unpublished";
    return {
      id: `release:${release.tag_name}`,
      title: release.name?.trim() || release.tag_name,
      detail: `${release.tag_name} · ${published} · ${release.assets?.length ?? 0} assets · ${downloads} downloads`,
      tags: [channel],
      state: channel,
      tag: release.tag_name,
    };
  });
}

if (import.meta.main) {
  const repository = process.env.DASH_BORED_GITHUB_REPOSITORY || "ArvidSU/dash-bored";
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=10`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dash-bored-dashboard" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    process.stderr.write(`GitHub returned ${response.status} for ${repository} releases.\n`);
    process.exit(1);
  }
  emit(releaseListItems(await response.json() as GitHubRelease[]));
}
