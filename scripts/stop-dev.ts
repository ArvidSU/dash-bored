import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.error("Stopping a dash-bored dev build is currently supported on macOS only.");
  process.exit(1);
}

const projectRoot = process.cwd().replace(/\/$/, "");
const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe" });
if (ps.exitCode !== 0) {
  console.error("Could not list processes.");
  process.exit(1);
}

const lsof = Bun.spawnSync(["lsof", "-d", "cwd", "-Fn"], { stdout: "pipe" });
if (lsof.exitCode !== 0) {
  console.error("Could not inspect process working directories.");
  process.exit(1);
}

const cwdByPid = new Map<number, string>();
let lsofPid: number | undefined;
for (const line of lsof.stdout.toString().split("\n")) {
  if (line.startsWith("p")) lsofPid = Number(line.slice(1));
  else if (line.startsWith("n") && lsofPid) cwdByPid.set(lsofPid, line.slice(1));
}

type ProcessInfo = { pid: number; ppid: number; command: string };
const processes: ProcessInfo[] = ps.stdout.toString().split("\n").flatMap((line) => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
});

const isDevRoot = (command: string) =>
  /\bbun\s+run\s+dev(?::desktop)?(?:\s|$)/.test(command) ||
  /(?:^|\/)scripts\/dev\.ts\s+(?:run|desktop)(?:\s|$)/.test(command);
const isDetachedDevWorker = (command: string) =>
  /(?:^|\/)vite(?:\s|$).*--host\s+127\.0\.0\.1/.test(command) ||
  /(?:^|\/)electrobun\s+dev\s+--watch(?:\s|$)/.test(command) ||
  /hutch-engine\s+electrobun\s+dev\s+--watch(?:\s|$)/.test(command) ||
  /\/node_modules\/\.bin\/concurrently\s+--kill-others(?:-on-fail)?.*vite.*electrobun dev --watch/.test(command);

const targets = new Set<number>();
// A detached restart worker must survive stopping the app that invoked it.
const protectedPids = new Set([process.pid, process.ppid]);
for (const proc of processes) {
  if (cwdByPid.get(proc.pid) === projectRoot && (isDevRoot(proc.command) || isDetachedDevWorker(proc.command))) {
    targets.add(proc.pid);
  }
}

// Include descendants of matched dev processes, such as esbuild and Hutch workers.
let changed = true;
while (changed) {
  changed = false;
  for (const proc of processes) {
    if (targets.has(proc.ppid) && !targets.has(proc.pid) && !protectedPids.has(proc.pid)) {
      targets.add(proc.pid);
      changed = true;
    }
  }
}

if (targets.size === 0) {
  await rm(join(projectRoot, ".hutch", "dev-starting"), { recursive: true, force: true });
  console.log(`No dash-bored dev build is running from ${projectRoot}.`);
  process.exit(0);
}

const ordered = [...targets].sort((a, b) => depth(b) - depth(a));
function depth(pid: number): number {
  let current = processes.find((proc) => proc.pid === pid);
  let result = 0;
  while (current && targets.has(current.ppid)) {
    result++;
    current = processes.find((proc) => proc.pid === current!.ppid);
  }
  return result;
}

for (const pid of ordered) {
  try { process.kill(pid, "SIGTERM"); } catch { /* It exited during discovery. */ }
}
await delay(1500);

const stillRunning: number[] = [];
for (const pid of targets) {
  try { process.kill(pid, 0); stillRunning.push(pid); } catch { /* Stopped. */ }
}
for (const pid of stillRunning) {
  try { process.kill(pid, "SIGKILL"); } catch { /* It exited after the check. */ }
}
await rm(join(projectRoot, ".hutch", "dev-starting"), { recursive: true, force: true });

console.log(`Stopped ${targets.size} dash-bored dev process${targets.size === 1 ? "" : "es"} from ${projectRoot}.`);
