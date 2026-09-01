import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./command.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";

export default function Command({
  props,
  host: componentHost,
}: ComponentRendererProps): ReactNode {
  const processApi = componentHost.processes;
  const process = processApi?.get();
  const running = process?.phase === "running" || process?.phase === "stopping";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(running);
  const outputRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const lastSequenceRef = useRef(0);
  const writeRef = useRef(processApi?.write);
  const resizeRef = useRef(processApi?.resize);
  const label = stringProp(props, ["label", "title"], "Run command");
  const command = stringProp(props, ["command"]);

  useEffect(() => {
    if (running) setTerminalVisible(true);
  }, [running]);

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
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      lineHeight: 1.35,
      scrollback: 2_000,
      theme: {
        background: "#080a0d",
        foreground: "#c2c9d2",
        cursor: "#d9ff68",
        selectionBackground: "#31401b",
      },
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

  if (!processApi?.start || !processApi.stop) {
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
      setTerminalVisible(false);
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
        {process && process.phase !== "idle" ? (
          <span className={`phase phase--${process.phase}`}>{process.phase}</span>
        ) : null}
      </div>
      <div className="command__actions">
        {!running ? (
          <button className="button button--quiet button--small" type="button" disabled={pending} onClick={() => void openTerminal()}>
            Open terminal
          </button>
        ) : null}
        <button
          className="button button--primary"
          type="button"
          disabled={pending || process?.phase === "stopping"}
          onClick={() => void runQuickAction()}
        >
          {pending ? "Working…" : label}
        </button>
        {running ? (
          <button className="button button--danger" type="button" disabled={pending || process?.phase === "stopping"} onClick={() => void closeTerminal()}>
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
