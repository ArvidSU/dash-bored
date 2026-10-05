import { lazy, Suspense } from "react";
import type { TerminalSurfaceProps } from "../../shared/contracts";

const TerminalSurfaceView = lazy(() => import("./TerminalSurfaceView"));

/** Load the terminal renderer only when a component or Agent work needs it. */
export function TerminalSurface(props: TerminalSurfaceProps) {
  return <Suspense fallback={<div className="terminal-surface command__terminal" aria-label={props.label ?? "Interactive terminal"}>Preparing terminal…</div>}>
    <TerminalSurfaceView {...props} />
  </Suspense>;
}
