import { useEffect, useRef, useState } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal-surface.css";
import { useTheme, terminalTheme } from "../lib/theme";
import { fitTerminal } from "../lib/terminal-fit";
import type { TerminalSurfaceProps } from "../../shared/contracts";

/** Shared PTY presentation; callbacks are already bound to the host's capability. */
export default function TerminalSurfaceView({ process, onWrite, onResize, scrollToLatest = 0, label = "Interactive terminal" }: TerminalSurfaceProps) {
  const { tokens } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const lastSequenceRef = useRef(0);
  const writeRef = useRef(onWrite);
  const resizeRef = useRef(onResize);
  useEffect(() => {
    writeRef.current = onWrite;
    resizeRef.current = onResize;
  }, [onResize, onWrite]);

  useEffect(() => {
    if (!outputRef.current) return;
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
      screenReaderMode: true,
      theme: terminalTheme(tokens),
    });
    terminal.open(output);
    terminalRef.current = terminal;

    terminal.write((process?.logs ?? []).map((entry) => entry.text).join(""), () => terminal.scrollToBottom());
    lastSequenceRef.current = process?.logs.at(-1)?.sequence ?? 0;

    const inputSubscription = terminal.onData((input) => {
      const write = writeRef.current;
      if (!write) return;
      void write(input).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    });
    const resize = (): void => {
      fitTerminal(terminal, output);
    };
    let fitFrame: number | undefined;
    const scheduleFit = (): void => {
      if (fitFrame !== undefined) return;
      fitFrame = requestAnimationFrame(() => { fitFrame = undefined; resize(); });
    };
    const renderSubscription = terminal.onRender(scheduleFit);
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      const resizeTerminal = resizeRef.current;
      if (resizeTerminal) void resizeTerminal(cols, rows).catch(() => undefined);
    });
    const observer = new ResizeObserver(resize);
    observer.observe(output);
    resize();

    return () => {
      observer.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      renderSubscription.dispose();
      resizeSubscription.dispose();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastSequenceRef.current = 0;
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme(tokens);
      terminalRef.current.options.fontFamily = tokens['font-mono'];
    }
  }, [tokens]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const logs = process?.logs ?? [];
    if ((logs.at(-1)?.sequence ?? 0) < lastSequenceRef.current) {
      terminal.clear();
      lastSequenceRef.current = 0;
    }
    const entries = logs.filter((entry) => entry.sequence > lastSequenceRef.current);
    if (entries.length === 0) return;
    const following = terminal.buffer.active.viewportY === terminal.buffer.active.baseY;
    terminal.write(entries.map((entry) => entry.text).join(""), () => {
      if (following) terminal.scrollToBottom();
    });
    lastSequenceRef.current = entries.at(-1)!.sequence;
  }, [process?.logs]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const resize = onResize;
    if (!terminal || !resize || process?.phase !== "running") return;
    void resize(terminal.cols, terminal.rows).catch(() => undefined);
  }, [process?.phase, Boolean(onResize)]);

  useEffect(() => { terminalRef.current?.scrollToBottom(); }, [scrollToLatest]);
  return <><div className="terminal-surface command__terminal" ref={outputRef} aria-label={label} />{error ? <p className="inline-error" role="alert">{error}</p> : null}</>;
}
