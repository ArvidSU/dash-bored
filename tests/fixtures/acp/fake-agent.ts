#!/usr/bin/env bun
// Deterministic fake ACP agent over stdio (test fixture).
// Prompt words control the scenario (whole words, so "changes" is not "hang"):
//   (default) chunk -> plan -> tool_call(edit, diff) -> request_permission -> tool_call_update -> end_turn
//   "hang"    chunk -> waits until session/cancel -> stopReason "cancelled"
//   "quick"   chunk -> end_turn
//   "refuse"  chunk -> stopReason "refusal"
//   "queue"   two concurrent permission requests (call-1, call-2) -> end_turn
//   "execute" permission request for an execute tool without locations -> end_turn
//   "bundle-edit" the default flow, editing .dash-bored/dash-bored.yaml instead of README.md
//   "future"  an update kind this SDK does not know -> chunk -> end_turn
//   "crash"   chunk -> process exits with code 3
//   "always"  bundle edit permission offering allow_once, allow_always, reject_once -> end_turn
//   "switch-mode" permission request for a switch_mode tool -> end_turn
//   "linked-edit" edit permission for .dash-bored/linked/escape.txt (tests make "linked" a symlink) -> end_turn
//   "late-permission" chunk -> waits until session/cancel -> permission request -> stopReason "cancelled"
// Scenarios that ask once log "fake-acp-agent: <scenario> <optionId|cancelled>" to stderr.
// Flags:
//   --auth        session/new requires authenticate (method "fake-login") first
//   --modes       session/new offers legacy modes instead of config options
//   --ignore-eof  keep running after stdin closes (shutdown must signal)
// The agent advertises session/close and logs each close to stderr.
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
  type ToolKind,
} from "@agentclientprotocol/sdk";

type SessionState = { cwd: string; model: string; mode: string; turn?: AbortController };

const ONCE: PermissionOption[] = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
const ALWAYS: PermissionOption[] = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
const chosen = (answer: RequestPermissionResponse | "cancelled") =>
  answer === "cancelled" || answer.outcome.outcome === "cancelled" ? "cancelled" : answer.outcome.optionId;

const flags = new Set(process.argv.slice(2));
const sessions = new Map<string, SessionState>();
let nextSession = 1;
let authenticated = !flags.has("--auth");

function configOptions(s: SessionState): SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: s.model,
      options: [
        { value: "fake-fast", name: "Fake Fast" },
        { value: "fake-smart", name: "Fake Smart" },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: s.mode,
      options: [
        { value: "ask", name: "Ask" },
        { value: "code", name: "Code" },
      ],
    },
  ];
}

/** Resolves when `signal` aborts; never rejects. */
const aborted = (signal: AbortSignal) =>
  new Promise<"cancelled">((resolve) => {
    if (signal.aborted) return resolve("cancelled");
    signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });

function session(id: string): SessionState {
  const s = sessions.get(id);
  if (!s) throw RequestError.resourceNotFound(id);
  return s;
}

const stdout = new WritableStream<Uint8Array>({
  write: (chunk) => void process.stdout.write(chunk),
});
const stream = ndJsonStream(stdout, Bun.stdin.stream());

const conn = new AgentSideConnection(
  (client): Agent => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {} },
      },
      authMethods: flags.has("--auth")
        ? [{ id: "fake-login", name: "Fake login", description: "Signs in without a browser." }, { id: "fake-terminal", name: "Terminal login", type: "terminal" }]
        : [],
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
    }),

    authenticate: async ({ methodId }) => {
      if (methodId !== "fake-login") throw RequestError.invalidParams({ methodId });
      authenticated = true;
      return {};
    },

    newSession: async ({ cwd }) => {
      if (!authenticated) throw RequestError.authRequired();
      const sessionId = `fake-session-${nextSession++}`;
      const s: SessionState = { cwd, model: "fake-fast", mode: "ask" };
      sessions.set(sessionId, s);
      if (flags.has("--modes")) {
        return {
          sessionId,
          modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code", description: "Edits files" }] },
        };
      }
      return { sessionId, configOptions: configOptions(s) };
    },

    setSessionMode: async ({ sessionId, modeId }) => {
      const s = session(sessionId);
      s.mode = modeId;
      console.error(`fake-acp-agent: mode ${modeId}`);
      return {};
    },

    setSessionConfigOption: async (params) => {
      const s = session(params.sessionId);
      if (!("value" in params) || typeof params.value !== "string") throw RequestError.invalidParams(params);
      if (params.configId === "model") s.model = params.value;
      else if (params.configId === "mode") s.mode = params.value;
      else throw RequestError.invalidParams({ configId: params.configId });
      return { configOptions: configOptions(s) };
    },

    closeSession: async ({ sessionId }) => {
      sessions.get(sessionId)?.turn?.abort();
      sessions.delete(sessionId);
      console.error(`fake-acp-agent: closed ${sessionId}`);
      return {};
    },

    cancel: async ({ sessionId }) => {
      sessions.get(sessionId)?.turn?.abort();
    },

    prompt: async ({ sessionId, prompt }): Promise<{ stopReason: StopReason }> => {
      const s = session(sessionId);
      s.turn?.abort();
      const turn = new AbortController();
      s.turn = turn;
      const text = prompt.map((b) => (b.type === "text" ? b.text : "")).join(" ");
      const has = (word: string) => new RegExp(`(^|[^\\w-])${word}($|[^\\w-])`).test(text);
      const update = (u: Parameters<typeof client.sessionUpdate>[0]["update"]) =>
        client.sessionUpdate({ sessionId, update: u });

      if (has("future")) {
        await client.sessionUpdate({ sessionId, update: { sessionUpdate: "future_kind", detail: 1 } as never });
      }
      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it." } });

      if (has("hang")) {
        await aborted(turn.signal);
        return { stopReason: "cancelled" };
      }
      if (has("crash")) process.exit(3);
      if (has("refuse")) return { stopReason: "refusal" };
      if (has("quick") || has("future")) return { stopReason: "end_turn" };

      const ask = (toolCallId: string, title: string, kind: ToolKind, locations: Array<{ path: string }>, options = ONCE) =>
        Promise.race([
          client.requestPermission({ sessionId, toolCall: { toolCallId, title, kind, status: "pending", locations }, options }),
          aborted(turn.signal),
        ]);
      const askOnce = async (scenario: string, kind: ToolKind, locations: Array<{ path: string }>, options = ONCE) => {
        console.error(`fake-acp-agent: ${scenario} ${chosen(await ask(`call-${scenario}`, scenario, kind, locations, options))}`);
        return { stopReason: "end_turn" as const };
      };

      if (has("always")) return askOnce("always", "edit", [{ path: `${s.cwd}/.dash-bored/dash-bored.yaml` }], ALWAYS);
      if (has("switch-mode")) return askOnce("switch-mode", "switch_mode", []);
      if (has("linked-edit")) return askOnce("linked-edit", "edit", [{ path: `${s.cwd}/.dash-bored/linked/escape.txt` }]);
      if (has("late-permission")) {
        await aborted(turn.signal);
        const answer = await client.requestPermission({
          sessionId,
          toolCall: { toolCallId: "call-late", title: "Late edit", kind: "edit", status: "pending", locations: [{ path: `${s.cwd}/README.md` }] },
          options: ONCE,
        });
        console.error(`fake-acp-agent: late-permission ${chosen(answer)}`);
        return { stopReason: "cancelled" };
      }

      if (has("queue")) {
        const answers = await Promise.all([
          ask("call-1", "First change", "edit", [{ path: `${s.cwd}/README.md` }]),
          ask("call-2", "Second change", "edit", [{ path: `${s.cwd}/README.md` }]),
        ]);
        console.error(`fake-acp-agent: answers ${answers.map(chosen).join(",")}`);
        return { stopReason: turn.signal.aborted ? "cancelled" : "end_turn" };
      }
      if (has("execute")) {
        await update({ sessionUpdate: "tool_call", toolCallId: "call-x", title: "Run tests", kind: "execute", status: "pending" });
        const answer = chosen(await ask("call-x", "Run tests", "execute", []));
        console.error(`fake-acp-agent: execute ${answer}`);
        await update({ sessionUpdate: "tool_call_update", toolCallId: "call-x", status: answer === "allow" ? "completed" : "failed" });
        return { stopReason: "end_turn" };
      }

      const path = has("bundle-edit") ? `${s.cwd}/.dash-bored/dash-bored.yaml` : `${s.cwd}/README.md`;
      await update({
        sessionUpdate: "plan",
        entries: [
          { content: "Edit README.md", priority: "high", status: "in_progress" },
          { content: "Report back", priority: "low", status: "pending" },
        ],
      });
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Edit README.md",
        kind: "edit",
        status: "pending",
        locations: [{ path, line: 1 }],
        content: [{ type: "diff", path, oldText: "hello\n", newText: "hello, world\n" }],
        rawInput: { path },
      });

      const answer = await Promise.race([
        client.requestPermission({
          sessionId,
          toolCall: { toolCallId: "call-1", title: "Edit README.md", kind: "edit", status: "pending" },
          options: ONCE,
        }),
        aborted(turn.signal),
      ]);
      if (answer === "cancelled" || answer.outcome.outcome === "cancelled" || turn.signal.aborted) {
        await update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
        return { stopReason: "cancelled" };
      }
      const allowed = answer.outcome.optionId === "allow";
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: allowed ? "completed" : "failed",
        rawOutput: { allowed },
      });
      await update({
        sessionUpdate: "plan",
        entries: [
          { content: "Edit README.md", priority: "high", status: "completed" },
          { content: "Report back", priority: "low", status: "completed" },
        ],
      });
      await update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: allowed ? "Done." : "Edit rejected." },
      });
      if (s.turn === turn) s.turn = undefined;
      return { stopReason: "end_turn" };
    },
  }),
  stream,
);

console.error("fake-acp-agent: ready");
await conn.closed;
if (flags.has("--ignore-eof")) {
  console.error("fake-acp-agent: ignoring stdin EOF");
  setInterval(() => undefined, 1_000);
} else {
  process.exit(0);
}
