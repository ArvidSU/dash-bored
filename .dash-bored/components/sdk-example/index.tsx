import {
  defineComponent,
  useCallback,
  useComponentVisibility,
  useEffect,
  useState,
} from "@dash-bored/component";
import "./styles.css";

interface Props {
  title?: string;
  focusMinutes?: number;
  breakMinutes?: number;
}

export default defineComponent<Props>(function FocusTimer({ props, host }) {
  const focusMinutes = props.focusMinutes ?? 25;
  const breakMinutes = props.breakMinutes ?? 5;
  const visible = useComponentVisibility();
  const [phase, setPhase] = useState<"focus" | "break">("focus");
  const [remainingMs, setRemainingMs] = useState(focusMinutes * 60_000);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [completed, setCompleted] = useState(0);
  const durationMs = (phase === "focus" ? focusMinutes : breakMinutes) * 60_000;
  const finished = remainingMs === 0;

  useEffect(() => {
    setPhase("focus");
    setRemainingMs(focusMinutes * 60_000);
    setDeadline(null);
    setCompleted(0);
  }, [focusMinutes, breakMinutes]);

  useEffect(() => {
    if (deadline === null || !visible) return;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setRemainingMs(remaining);
      if (remaining === 0) setDeadline(null);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadline, visible]);

  const seconds = Math.ceil(remainingMs / 1000);
  const message = finished
    ? phase === "focus" ? "Focus complete. Take a breath." : "Break complete. Ready when you are."
    : deadline !== null ? "Stay with the work in front of you."
    : remainingMs < durationMs ? "Paused. Pick up when you are ready."
    : "A little space for meaningful work.";

  const pause = useCallback(() => {
    if (deadline !== null) {
      setRemainingMs(Math.max(0, deadline - Date.now()));
      setDeadline(null);
    }
  }, [deadline]);

  const startNext = useCallback(() => {
    if (phase === "focus") setCompleted((count) => count + 1);
    const nextPhase = phase === "focus" ? "break" : "focus";
    const nextDuration = (nextPhase === "focus" ? focusMinutes : breakMinutes) * 60_000;
    setPhase(nextPhase);
    setRemainingMs(nextDuration);
    setDeadline(Date.now() + nextDuration);
  }, [breakMinutes, focusMinutes, phase]);

  const start = useCallback(() => {
    if (finished) startNext();
    else setDeadline(Date.now() + remainingMs);
  }, [finished, remainingMs, startNext]);
  const reset = useCallback(() => {
    setDeadline(null);
    setRemainingMs(durationMs);
  }, [durationMs]);
  const toggle = useCallback(() => {
    if (deadline !== null) pause();
    else start();
  }, [deadline, pause, start]);

  useEffect(() => {
    const cleanups = [
      host.actions.register({ id: "start", label: "Start timer", run: start }),
      host.actions.register({ id: "pause", label: "Pause timer", run: pause }),
      host.actions.register({ id: "reset", label: "Reset timer", run: reset }),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [host.actions, pause, reset, start]);

  return <section className="sdk-example-timer" data-phase={phase} aria-label="Focus timer">
    <p className="sdk-example-timer__eyebrow">{phase === "focus" ? "FOCUS SESSION" : "ROOM TO BREATHE"}</p>
    <h2>{props.title ?? "One thing at a time"}</h2>
    <div className="sdk-example-timer__clock" role="timer" aria-label={Math.floor(seconds / 60) + " minutes " + (seconds % 60) + " seconds remaining"}>
      {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
    </div>
    <p className="sdk-example-timer__message" role="status">{message}</p>
    <div className="sdk-example-timer__controls">
      {finished
        ? <button type="button" onClick={startNext}>Start {phase === "focus" ? "break" : "focus"}</button>
        : <button type="button" onClick={toggle}>{deadline !== null ? "Pause" : remainingMs < durationMs ? "Resume" : "Start " + phase}</button>}
      <button type="button" className="sdk-example-timer__reset" disabled={remainingMs === durationMs && deadline === null} onClick={reset}>Reset</button>
    </div>
    <footer>{completed} focus sessions completed</footer>
  </section>;
});
