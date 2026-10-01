import type { Terminal } from "@xterm/xterm";

/** Fit measured cells within the content box; hidden terminals keep their PTY size. */
export function fitTerminal(terminal: Terminal, output: HTMLElement): void {
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || output.clientWidth === 0 || output.clientHeight === 0) return;
  const screenStyle = getComputedStyle(screen);
  const cellWidth = parseFloat(screenStyle.width) / terminal.cols;
  const cellHeight = parseFloat(screenStyle.height) / terminal.rows;
  if (!(cellWidth > 0 && cellHeight > 0)) return;
  const padding = getComputedStyle(output);
  const scrollbar = terminal.element?.querySelector<HTMLElement>(".scrollbar.vertical");
  const width = output.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight)
    - (scrollbar?.offsetWidth ?? 0);
  const height = output.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
  if (width < cellWidth * 2 || height < cellHeight) return;
  const cols = Math.min(500, Math.floor(width / cellWidth));
  const rows = Math.min(200, Math.floor(height / cellHeight));
  if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
}
