import { useTheme, terminalTheme } from "../../lib/theme";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./command.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";
import { isProcessLive, isProcessRunActive, processRun, processRunFailed, processRunOutcome } from "../../../shared/process-state";

export default function Command({
  props,
  host: componentHost,
}: ComponentRendererProps): ReactNode {
  const { tokens } = useTheme();
  const processApi = componentHost.processes;
  const process = processApi?.get();
  // The terminal stays open between runs; only an active run blocks another.
  const live = isProcessLive(process);
  const runActive = isProcessRunActive(process);
  const stopping = process?.phase === "stopping";
  const run = processRun(process);
  const attachOnly = processApi?.attachOnly === true;
  const canStart = !attachOnly && Boolean(processApi?.start);
  const canStop = Boolean(processApi?.stop);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(
    attachOnly ? process !== undefined && process.phase !== "idle" : live,
  );
  const outputRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const lastSequenceRef = useRef(0);
  const writeRef = useRef(processApi?.write);
  const resizeRef = useRef(processApi?.resize);
  const label = stringProp(props, ["label", "title"], "Run command");
  const command = stringProp(props, ["command"]);

  useEffect(() => componentHost.actions.register({
    id: "run",
    label: `Run ${label}`,
    description: "Run the configured command with selected item values in DASH_ITEM_* environment variables.",
    enabled: Boolean(processApi?.start) && !runActive && !stopping,
    disabledReason: !processApi?.start ? "Trust this project to run the command."
      : runActive ? "This command is already running."
        : stopping ? "This terminal is closing." : undefined,
    invocationOutcome: "started",
    process,
    run: async (_selections, args = {}) => {
      if (!processApi?.start) throw new Error("The command is unavailable.");
      const itemEnvironment: Record<string, string> = {};
      for (const [field, value] of Object.entries(args)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
          throw new Error(`Unsupported item action argument: ${field}`);
        }
        const key = `DASH_ITEM_${field.toUpperCase()}`;
        if (key in itemEnvironment) throw new Error(`Duplicate item environment name: ${key}`);
        itemEnvironment[key] = String(value);
      }
      setTerminalVisible(true);
      const started = await processApi.start(itemEnvironment);
      if (started.phase === "failed" || started.run?.phase === "failed") {
        throw new Error("The command could not start. Inspect its process output.");
      }
    },
  }), [componentHost.actions, label, processApi?.start, process, runActive, stopping]);

  useEffect(() => {
    if (live) setTerminalVisible(true);
  }, [live]);

  useEffect(() => {
    writeRef.current = processApi?.write;
    resizeRef.current = processApi?.resize;
  }, [processApi?.resize, processApi?.write]);

  useEffect(() => {
    if (!terminalVisible || !outputRef.current) return;
    const output = outputRef.current;
    const terminal = new XtermTerminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: tokens["font-mono"],
      fontSize: 11,
      lineHeight: 1.35,
      scrollback: 2_000,
      theme: terminalTheme(tokens),
    });
    terminal.open(output);
    terminalRef.current = terminal;

    for (const entry of process?.logs ?? []) terminal.write(entry.text);
    lastSequenceRef.current = process?.logs.at(-1)?.sequence ?? 0;

    const inputSubscription = terminal.onData((input) => {
      const write = writeRef.current;
      if (!write) return;
      void write(input).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    });
    const resize = (): void => {
      const bounds = output.getBoundingClientRect();
      const cols = Math.max(20, Math.min(500, Math.floor(bounds.width / 8.1)));
      const rows = Math.max(4, Math.min(200, Math.floor(bounds.height / 16)));
      terminal.resize(cols, rows);
      const resizeTerminal = resizeRef.current;
      if (resizeTerminal) void resizeTerminal(cols, rows).catch(() => undefined);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(output);
    resize();

    return () => {
      observer.disconnect();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastSequenceRef.current = 0;
    };
  }, [terminalVisible]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme(tokens);
      terminalRef.current.options.fontFamily = tokens['font-mono'];
    }
  }, [tokens]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !terminalVisible) return;
    const logs = process?.logs ?? [];
    if ((logs.at(-1)?.sequence ?? 0) < lastSequenceRef.current) {
      terminal.clear();
      lastSequenceRef.current = 0;
    }
    for (const entry of logs) {
      if (entry.sequence <= lastSequenceRef.current) continue;
      terminal.write(entry.text);
      lastSequenceRef.current = entry.sequence;
    }
  }, [process?.logs, terminalVisible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const resize = processApi?.resize;
    if (!terminal || !resize || !terminalVisible || process?.phase !== "running") return;
    void resize(terminal.cols, terminal.rows).catch(() => undefined);
  }, [process?.phase, processApi?.resize, terminalVisible]);

  if (!processApi || (!attachOnly && (!processApi.start || !processApi.stop))) {
    return (
      <CapabilityGate title={label}>
        Trust this project to run its configured command.
      </CapabilityGate>
    );
  }

  async function runQuickAction(): Promise<void> {
    const run = processApi?.runQuickAction;
    if (!run) return;
    setPending(true);
    setError(null);
    setTerminalVisible(true);
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function openTerminal(): Promise<void> {
    const open = processApi?.open;
    if (!open) return;
    setPending(true);
    setError(null);
    setTerminalVisible(true);
    try {
      await open();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function closeTerminal(): Promise<void> {
    const stop = processApi?.stop;
    if (!stop) return;
    setPending(true);
    setError(null);
    try {
      await stop();
      // Attached agent tasks remain mounted after stopping so the user can
      // review the output that caused the run to finish.
      if (!attachOnly) setTerminalVisible(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="command">
      <div className="command__content">
        <strong>{label}</strong>
        {command ? <code>{command}</code> : null}
        {run ? (
          <span
            className={runActive ? "phase phase--running" : processRunFailed(run) ? "phase phase--failed" : "phase"}
            title={runActive ? "The command is running." : "Result of the latest run."}
          >
            {processRunOutcome(run)}
          </span>
        ) : live ? <span className="phase">open</span> : null}
      </div>
      <div className="command__actions">
        {canStart && !live ? (
          <button className="button button--quiet button--small" type="button" disabled={pending} onClick={() => void openTerminal()}>
            Open terminal
          </button>
        ) : null}
        {canStart ? (
          <button
            className="button button--primary"
            type="button"
            disabled={pending || stopping || runActive}
            title={runActive ? "The command is running. Press Ctrl-C in the terminal or close it to stop." : undefined}
            onClick={() => void runQuickAction()}
          >
            {pending ? "Working…" : runActive ? "Running…" : label}
          </button>
        ) : null}
        {live && canStop ? (
          <button className="button button--danger" type="button" disabled={pending || stopping} onClick={() => void closeTerminal()}>
            Close terminal
          </button>
        ) : null}
      </div>
      {terminalVisible ? (
        <div
          className="command__terminal"
          ref={outputRef}
          aria-label={`Interactive terminal for ${label}`}
        />
      ) : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
