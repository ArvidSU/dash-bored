import { APP_VERSION } from "../shared/app-metadata";
import type { PublishedRelease, ReleaseMetadata } from "../shared/updates";

export const RELEASE_REPOSITORY = "ArvidSU/dash-bored";
export const RELEASE_ASSET_BASE = `https://github.com/${RELEASE_REPOSITORY}/releases/download/`;
export const RELEASE_METADATA_FILE = "dash-bored-release.json";
export const DASHBOARD_CONTRACT = 3;
export const BUNDLED_MIGRATIONS: Pick<ReleaseMetadata, "minimumContract" | "dashboardContract" | "recipes"> = {
  minimumContract: 2,
  dashboardContract: DASHBOARD_CONTRACT,
  recipes: [{
    id: "compact-child-topology",
    from: 2,
    to: 3,
    title: "Simplify dashboard child topology",
    instructions: `Convert only the selected dashboard from schemaVersion 2 to 3.
Recursively replace each node's children {type: managed, items: [...]} with its items array, preserving every edge's node and metadata.
Replace children {type: tiled, layout: ...} with its layout. In each layout, replace {type: child, child: edge} with edge, and remove type: split from split branches.
Keep each split's axis, first, and second. Keep non-default horizontal ratios; omit horizontal ratio 0.5 (the default). Remove vertical ratios because vertical branches use document flow.
Preserve node IDs, component references, props, edge metadata, child order, binary grouping, and top-level dashboard settings. Do not rewrite data inside props or metadata as topology.
Set the dashboard schemaVersion to 3 after conversion. Component manifests remain schemaVersion 2; lock files and themes are unchanged. Linked dashboards are independent migration targets, not authorization to edit other bundles.
Validate with the version-matched CLI and inspect the diff against the host snapshot.`,
  }],
};

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) throw new Error(`Unsupported release version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), pre: match[4] };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! - b.numbers[i]!;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const aa = a.pre.split('.'), bb = b.pre.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i], y = bb[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function parseReleaseMetadata(value: unknown): ReleaseMetadata {
  if (!value || typeof value !== "object") throw new Error("Release metadata is not an object.");
  const m = value as ReleaseMetadata;
  if (m.format !== 1 || m.product !== "dash-bored" || m.channel !== "canary" || m.platform !== "macos" || m.arch !== "arm64") throw new Error("Unsupported release metadata identity, channel, or platform.");
  compareVersions(m.version, m.version);
  for (const artifact of [m.archive, m.dmg, m.updater]) {
    if (!artifact || !/^[a-zA-Z0-9_.-]+$/.test(artifact.file) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Invalid release artifact or SHA-256.");
  }
  if (m.updater.file !== 'canary-macos-arm64-update.json') throw new Error('Unexpected native updater manifest filename.');
  if (!m.archive.file.endsWith('.app.tar.zst') || !m.dmg.file.endsWith('.dmg')) throw new Error("Unexpected release artifact format.");
  if (!Number.isSafeInteger(m.dashboardContract) || !Number.isSafeInteger(m.minimumContract) || m.minimumContract < 2 || m.dashboardContract < m.minimumContract || m.dashboardContract > 1000 || typeof m.notes !== "string" || m.notes.length > 100_000 || !Array.isArray(m.recipes)) throw new Error("Invalid migration metadata.");
  const ids = new Set<string>();
  for (const r of m.recipes) {
    if (!r || !/^[a-z0-9-]+$/.test(r.id) || ids.has(r.id) || !Number.isSafeInteger(r.from) || r.from < m.minimumContract || r.to !== r.from + 1 || r.to > m.dashboardContract || typeof r.title !== "string" || typeof r.instructions !== "string" || !r.instructions.trim() || r.instructions.length > 100_000) throw new Error("Invalid migration recipe.");
    ids.add(r.id);
  }
  for (let from = m.minimumContract; from < m.dashboardContract; from++) {
    if (m.recipes.filter(r => r.from === from).length !== 1) throw new Error(`Missing or ambiguous cumulative migration from contract ${from}.`);
  }
  return structuredClone(m);
}

export async function fetchJson(url: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Release check failed: HTTP ${response.status}. Retry when GitHub is reachable.`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("Release metadata exceeds the size limit.");
  return JSON.parse(text);
}

export async function discoverRelease(current = APP_VERSION, fetcher: typeof fetch = fetch): Promise<PublishedRelease | null> {
  const releases = await fetchJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100`, fetcher);
  if (!Array.isArray(releases)) throw new Error("Malformed GitHub release list.");
  const candidates = releases.filter(r => r && !r.draft && typeof r.tag_name === "string" && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(r.tag_name) && Array.isArray(r.assets) && r.assets.some((a: { name: string }) => a.name === RELEASE_METADATA_FILE))
    .filter(r => compareVersions(r.tag_name.slice(1), current) > 0)
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  for (const candidate of candidates) {
    const assetBase = `${RELEASE_ASSET_BASE}${candidate.tag_name}/`;
    const raw = await fetchJson(`${assetBase}${RELEASE_METADATA_FILE}`, fetcher);
    if (raw && typeof raw === 'object' && 'channel' in raw && raw.channel !== 'canary') continue;
    const metadata = parseReleaseMetadata(raw);
    if (`v${metadata.version}` !== candidate.tag_name) throw new Error("Release tag and metadata version disagree.");
    for (const a of [metadata.archive, metadata.dmg, metadata.updater]) if (!candidate.assets.some((asset: { name: string }) => asset.name === a.file)) throw new Error(`Release is missing ${a.file}.`);
    return { metadata, assetBase, url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${candidate.tag_name}` };
  }
  return null;
}
