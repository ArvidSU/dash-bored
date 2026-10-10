#!/usr/bin/env bun
// Deterministic fake ACP agent over stdio (test fixture).
// Prompt text controls the scenario:
//   (default) chunk -> plan -> tool_call(edit, diff) -> request_permission -> tool_call_update -> end_turn
//   "hang"    chunk -> waits until session/cancel -> stopReason "cancelled"
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type SessionConfigOption,
  type StopReason,
} from "@agentclientprotocol/sdk";

type SessionState = { cwd: string; model: string; mode: string; turn?: AbortController };

const sessions = new Map<string, SessionState>();
let nextSession = 1;

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
      },
      authMethods: [],
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
    }),

    authenticate: async () => ({}),

    newSession: async ({ cwd }) => {
      const sessionId = `fake-session-${nextSession++}`;
      const s: SessionState = { cwd, model: "fake-fast", mode: "ask" };
      sessions.set(sessionId, s);
      return { sessionId, configOptions: configOptions(s) };
    },

    setSessionConfigOption: async (params) => {
      const s = session(params.sessionId);
      if (!("value" in params) || typeof params.value !== "string") throw RequestError.invalidParams(params);
      if (params.configId === "model") s.model = params.value;
      else if (params.configId === "mode") s.mode = params.value;
      else throw RequestError.invalidParams({ configId: params.configId });
      return { configOptions: configOptions(s) };
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
      const update = (u: Parameters<typeof client.sessionUpdate>[0]["update"]) =>
        client.sessionUpdate({ sessionId, update: u });

      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it." } });

      if (text.includes("hang")) {
        await aborted(turn.signal);
        return { stopReason: "cancelled" };
      }

      const path = `${s.cwd}/README.md`;
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
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
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
process.exit(0);
