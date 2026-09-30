import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import "./focus-timer.css";

export default function FocusTimer({ props, host }: ComponentRendererProps): ReactNode {
  const focusMinutes = typeof props.focusMinutes === "number" ? props.focusMinutes : 25;
  const breakMinutes = typeof props.breakMinutes === "number" ? props.breakMinutes : 5;
  // Configuration changes create a fresh session; ordinary rerenders retain it.
  return <Timer host={host} key={`${focusMinutes}:${breakMinutes}`} title={typeof props.title === "string" ? props.title : "One thing at a time"} focusMinutes={focusMinutes} breakMinutes={breakMinutes} />;
}

function Timer({ title, focusMinutes, breakMinutes, host }: { title: string; focusMinutes: number; breakMinutes: number; host: ComponentRendererProps["host"] }): ReactNode {
  const [phase, setPhase] = useState<"focus" | "break">("focus");
  const duration = (phase === "focus" ? focusMinutes : breakMinutes) * 60_000;
  const [remaining, setRemaining] = useState(focusMinutes * 60_000);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [completed, setCompleted] = useState(0);
  const finished = remaining === 0;
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => {
      const next = Math.max(0, deadline - Date.now());
      setRemaining(next);
      if (next === 0) setDeadline(null);
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [deadline]);
  const seconds = Math.ceil(remaining / 1000);
  const label = finished ? (phase === "focus" ? "Focus complete. Take a breath." : "Break complete. Ready when you are.") : deadline !== null ? (phase === "focus" ? "Make room for your next good idea." : "Step away. Stretch. Look outside.") : remaining < duration ? "Paused. Pick up when you’re ready." : "A little space for meaningful work.";
  const toggle = useCallback(() => {
    if (deadline !== null) {
      setRemaining(Math.max(0, deadline - Date.now()));
      setDeadline(null);
    } else setDeadline(Date.now() + remaining);
  }, [deadline, remaining]);
  const next = useCallback(() => {
    if (phase === "focus") setCompleted((count) => count + 1);
    const nextPhase = phase === "focus" ? "break" : "focus";
    const nextDuration = (nextPhase === "focus" ? focusMinutes : breakMinutes) * 60_000;
    setPhase(nextPhase);
    setRemaining(nextDuration);
    setDeadline(Date.now() + nextDuration);
  }, [phase, focusMinutes, breakMinutes]);
  const reset = useCallback(() => { setDeadline(null); setRemaining(duration); }, [duration]);
  useEffect(() => {
    const unregister = [
      host.actions.register({ id: "start", label: "Start or resume timer", enabled: deadline === null && !finished, disabledReason: finished ? "Start the next session after completion." : "Timer is already running.", run: toggle }),
      host.actions.register({ id: "pause", label: "Pause timer", enabled: deadline !== null, disabledReason: "Timer is not running.", run: toggle }),
      host.actions.register({ id: "reset", label: "Reset timer", enabled: remaining !== duration || deadline !== null, disabledReason: "Timer is already reset.", run: reset }),
      host.actions.register({ id: "next", label: "Start next timer session", enabled: finished, disabledReason: "Finish the current session first.", run: next }),
    ];
    return () => unregister.forEach((remove) => remove());
  }, [host.actions, deadline, finished, remaining, duration, phase, focusMinutes, breakMinutes, toggle, next, reset]);
  return <section className="focus-timer" aria-label="Focus timer" data-phase={phase}>
    <div className="focus-timer__eyebrow"><span className="focus-timer__dot" />{phase === "focus" ? "FOCUS SESSION" : "ROOM TO BREATHE"}<span>{focusMinutes} / {breakMinutes}</span></div>
    <h2>{title}</h2>
    <div className="focus-timer__dial">
      <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="focus-timer__track" cx="100" cy="100" r="90" /><circle className="focus-timer__progress" cx="100" cy="100" r="90" pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - remaining / duration)} /></svg>
      <div><span className="focus-timer__time" role="timer" aria-label={`${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds remaining`}>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span><span className="focus-timer__phase">{finished ? "COMPLETE" : phase === "focus" ? "STAY WITH IT" : "TAKE IT EASY"}</span></div>
    </div>
    <p className="focus-timer__message" role="status">{label}</p>
    <div className="focus-timer__controls">
      {finished ? <button type="button" onClick={next}>Start {phase === "focus" ? "break" : "focus"}</button> : <button type="button" onClick={toggle}>{deadline !== null ? "Pause" : remaining < duration ? "Resume" : `Start ${phase}`}</button>}
      <button type="button" className="focus-timer__reset" disabled={remaining === duration && deadline === null} onClick={reset}>Reset</button>
    </div>
    <footer><span>{completed + (finished && phase === "focus" ? 1 : 0)} focus sessions completed</span><span>Resets when dashboard closes</span></footer>
  </section>;
}
