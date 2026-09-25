// Objective checks for skill eval runs; qualitative review stays manual.
// Usage: bun scripts/eval/skill/grade.ts <eval-dir>
// Prints a Markdown report per run directory in <eval-dir>/runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { parseDashboardList } from "../../../src/renderer/lib/list-data";
import { parseSourceChart, parseStatusValue } from "../../../src/renderer/lib/view-shapes";

const repo = resolve(import.meta.dir, "../../..");
const evalDir = resolve(process.argv[2] ?? "");
const legacy = new Set(["card", "tabs", "todo-list", "live-chart", "conditional", "setup-agent", "focus-timer"]
  .map((name) => `@dash-bored/${name}`));

type Node = { id?: string; component: string; props?: Record<string, any>; children?: any };

function* walk(node: Node): Generator<Node> {
  yield node;
  const edges: Array<{ node: Node }> = [];
  const layout = (value: any): void => {
    if (!value) return;
    if ("node" in value) edges.push(value);
    else { layout(value.first); layout(value.second); }
  };
  if (Array.isArray(node.children)) edges.push(...node.children);
  else layout(node.children);
  for (const edge of edges) yield* walk(edge.node);
}

function nodes(configPath: string): Node[] {
  return existsSync(configPath) ? [...walk(parse(readFileSync(configPath, "utf8")).root)] : [];
}

/** Runs a shell source the way the app does, from a stripped environment. */
function runShell(shell: string, cwd: string) {
  const result = Bun.spawnSync(["env", "-i", `HOME=${process.env.HOME}`, "/bin/sh", "-lc", shell],
    { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const stdout = result.stdout.toString();
  let value: unknown = stdout;
  try { value = JSON.parse(stdout); } catch {}
  return { exit: result.exitCode, value, stderr: result.stderr.toString().trim().slice(-200) };
}

function changedOutsideBundle(directory: string): string[] {
  return Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: directory, stdout: "pipe" })
    .stdout.toString().split("\n").filter(Boolean).map((line) => line.slice(3))
    .filter((path) => !path.startsWith(".dash-bored/"));
}

const list = (values: unknown[]) => values.length ? values.join(", ") : "none";

for (const run of readdirSync(join(evalDir, "runs"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  const root = join(evalDir, "runs", run);
  const fixture = join(evalDir, "fixtures", run.replace(/-(baseline|candidate)\d*$/, ""));
  const report: string[] = [];

  const validate = Bun.spawnSync(["bun", join(repo, "src/cli/index.ts"), "validate", ".", "--json"], { cwd: root, stdout: "pipe" });
  let ok = false;
  try { ok = JSON.parse(validate.stdout.toString()).ok === true; } catch {}
  report.push(`validate ok: ${ok}`);

  const before = new Set(nodes(join(fixture, ".dash-bored/dash-bored.yaml")).map((node) => node.id).filter(Boolean));
  const all = nodes(join(root, ".dash-bored/dash-bored.yaml"));
  const added = all.filter((node) => !node.id || !before.has(node.id));
  report.push(`nodes: ${all.length} (${added.length} new)`);
  report.push(`new legacy components: ${list(added.filter((node) => legacy.has(node.component)).map((node) => `${node.id}:${node.component}`))}`);
  report.push(`hand-written status state: ${list(all.filter((node) => node.component === "@dash-bored/status"
    && node.props?.state !== undefined && !node.props?.source).map((node) => node.id))}`);
  report.push(`titled single-child frames: ${list(all.filter((node) => ["@dash-bored/group", "@dash-bored/card"].includes(node.component)
    && node.props?.title && node.children && !Array.isArray(node.children) && "node" in node.children).map((node) => node.id))}`);
  report.push(`nodes without id: ${all.filter((node) => !node.id).length}`);
  report.push(`local components: ${list([...new Set(all.filter((node) => node.component.startsWith("./components/")).map((node) => node.component))])}`);

  for (const node of all) {
    const source = node.props?.source;
    if (!source || typeof source !== "object") continue;
    const kind = ["shell", "file", "http", "process", "inline"].find((key) => key in source);
    if (kind !== "shell") {
      report.push(`source ${node.id} (${node.component}): ${kind} ${JSON.stringify(source[kind!]).slice(0, 60)}`);
      continue;
    }
    const result = runShell(source.shell, source.cwd ? join(root, source.cwd) : root);
    let shape = "unchecked";
    if (node.component === "@dash-bored/status") shape = parseStatusValue(result.value) ? "ok" : "BAD";
    if (node.component === "@dash-bored/chart") shape = parseSourceChart(result.value) ? "ok" : "BAD";
    if (node.component === "@dash-bored/markdown") shape = typeof result.value === "string" ? "text" : "json";
    if (node.component === "@dash-bored/list") {
      const parsed = parseDashboardList(result.value);
      shape = parsed.diagnostics.length ? `BAD ${JSON.stringify(parsed.diagnostics[0])}` : `ok (${parsed.items.length} items)`;
    }
    report.push(`source ${node.id} (${node.component.replace("@dash-bored/", "")}): exit ${result.exit}, shape ${shape}`
      + `${result.exit ? `, stderr: ${result.stderr}` : ""}, every=${source.every ?? "-"}`);
  }
  for (const node of all) {
    for (const action of node.props?.itemActions ?? []) {
      report.push(`item action ${node.id}: ${action.name} -> ${JSON.stringify(action.action).slice(0, 110)}`);
    }
  }

  const baselineChanges = changedOutsideBundle(fixture);
  report.push(`changes outside .dash-bored: ${list(changedOutsideBundle(root).filter((path) => !baselineChanges.includes(path)))}`);
  report.push(`fixture node IDs removed: ${list([...before].filter((id) => !all.some((node) => node.id === id)))}`);
  if (run.startsWith("acme-api-")) report.push(`icon exists: ${existsSync(join(root, ".dash-bored/assets/icon.svg"))}`);
  report.push(`trace: ${existsSync(join(evalDir, "runs", `${run}.trace.md`)) ? "yes" : "missing"}`);
  console.log(`\n## ${run}\n- ${report.join("\n- ")}`);
}
