// Deterministic fixtures for the atoms lab. Every mode is harmless: the only
// file it writes is the gitignored signal state next to this bundle.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SIGNAL_PATH = process.env.DASH_LAB_SIGNAL || ".dash-bored/dogfood/lab/signal.json";
const CYCLE = ["healthy", "warning", "error"] as const;

type SignalState = (typeof CYCLE)[number];

interface Signal {
  state: SignalState;
  flips: number;
  at: string;
}

function emit(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

async function readSignal(): Promise<Signal | undefined> {
  const file = Bun.file(SIGNAL_PATH);
  if (!(await file.exists())) return undefined;
  return await file.json() as Signal;
}

const modes: Record<string, () => Promise<void> | void> = {
  async signal() {
    const signal = await readSignal();
    emit(signal
      ? { state: signal.state, detail: `Flipped ${signal.flips} time${signal.flips === 1 ? "" : "s"} · last ${signal.at.slice(11, 19)}` }
      : { state: "unknown", detail: "Press Flip signal to write the first state." });
  },
  async flip() {
    const previous = await readSignal();
    const next: Signal = {
      state: CYCLE[((previous ? CYCLE.indexOf(previous.state) : -1) + 1) % CYCLE.length]!,
      flips: (previous?.flips ?? 0) + 1,
      at: new Date().toISOString(),
    };
    await mkdir(dirname(SIGNAL_PATH), { recursive: true });
    await Bun.write(SIGNAL_PATH, `${JSON.stringify(next)}\n`);
    emit(`Signal is now ${next.state} (flip ${next.flips}). The status tile polls every 2s.`);
  },
  wave() {
    const now = Date.now() / 1000;
    const labels = Array.from({ length: 24 }, (_, index) => `${index - 23}s`);
    const values = (phase: number, scale: number) => labels.map((_, index) => Math.round((Math.sin((now + index - 23 + phase) / 3) * scale + scale) * 10) / 10);
    emit({ labels, series: [{ label: "Sine", values: values(0, 10) }, { label: "Shifted", values: values(4, 6) }] });
  },
  markdown() {
    const greeting = process.env.DASH_LAB_GREETING ?? "(DASH_LAB_GREETING not set)";
    emit([
      "### Shell text source",
      "",
      `Rendered at **${new Date().toLocaleTimeString()}** from \`lab.ts markdown\`.`,
      "",
      `- Source \`env\` value: \`${greeting}\``,
      `- Working directory: \`${process.cwd().split("/").slice(-2).join("/")}\``,
      "- Polls every 5s while visible; switch panels and it pauses.",
    ].join("\n"));
  },
  items() {
    emit([
      { id: "lab:alpha", title: "Alpha — healthy item", detail: "Runs the echo command with DASH_ITEM_* values.", tags: ["lab", "ok"], state: "healthy", name: "alpha", count: 1 },
      { id: "lab:beta", title: "Beta — warning item", detail: "Numbers pass through as strings in the environment.", tags: ["lab", "warn"], state: "warning", name: "beta", count: 2 },
      { id: "lab:gamma", title: "Gamma — closed item", detail: "Closed states sort after open ones.", tags: ["lab"], state: "done", name: "gamma", count: 3 },
      { id: "lab:delta", title: "Delta — no count field", detail: "Run should report a missing ${item.count} value.", tags: ["lab", "error-path"], state: "error", name: "delta" },
    ]);
  },
  "duplicate-ids"() {
    emit([
      { id: "same", title: "First item with id 'same'" },
      { id: "same", title: "Second item with id 'same'" },
      { title: "Item without an id" },
    ]);
  },
  "bad-shape"() {
    emit({ status: "ok", message: "A status view expects { state, detail? }." });
  },
  fail() {
    process.stderr.write("Deliberate lab failure: this source always exits 3.\n");
    process.exit(3);
  },
  async slow() {
    await Bun.sleep(5000);
    emit({ state: "healthy", detail: "Too late — the source timeout should win." });
  },
  async countdown() {
    const seconds = Number(process.env.DASH_LAB_SECONDS || "5");
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      console.log(`Finishing in ${remaining}…`);
      await Bun.sleep(1000);
    }
    const code = Number(process.env.DASH_LAB_EXIT_CODE || "0");
    console.log(code ? `Exiting with ${code}.` : "Done.");
    process.exit(code);
  },
};

const mode = process.argv[2] ?? "";
const run = modes[mode];
if (!run) {
  process.stderr.write(`Usage: bun run .dash-bored/dogfood/scripts/lab.ts <${Object.keys(modes).join("|")}>\n`);
  process.exit(2);
}
await run();
