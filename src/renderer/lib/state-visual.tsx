export type StateTone = "positive" | "warning" | "negative" | "neutral";

/** Semantic states share color and shape; arbitrary source states stay neutral. */
export function stateTone(state: string | undefined, done = false): StateTone {
  const normalized = state?.toLowerCase();
  if (done || ["ok", "online", "healthy", "success", "ready", "done", "completed", "closed"].includes(normalized ?? "")) return "positive";
  if (["warn", "warning", "pending", "starting", "running", "stopping"].includes(normalized ?? "")) return "warning";
  if (["error", "failed", "offline", "down"].includes(normalized ?? "")) return "negative";
  return "neutral";
}

export function StateGlyph({ tone }: { tone: StateTone }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {tone === "positive" ? <><circle cx="10" cy="10" r="7" /><path d="m6.5 10 2.3 2.3 4.7-4.6" /></>
      : tone === "warning" ? <><path d="M10 2.5 18 17H2Z" /><path d="M10 7.5v4M10 14h.01" /></>
        : tone === "negative" ? <><circle cx="10" cy="10" r="7" /><path d="m7.5 7.5 5 5m0-5-5 5" /></>
          : <><circle cx="10" cy="10" r="7" /><path d="M7.5 10h5" /></>}
  </svg>;
}

export type ActionVerb = "process" | "agent" | "navigate" | "refresh" | "action";

/** Visual verbs come from the action contract, never project-specific names. */
export function actionVerb(reference: string): ActionVerb {
  if (reference.startsWith("process:")) return "process";
  if (reference.startsWith("agent:")) return "agent";
  if (reference.startsWith("select:") || reference.startsWith("reveal:") || reference.startsWith("focus:")) return "navigate";
  if (reference.endsWith(":refresh")) return "refresh";
  return "action";
}

export function ActionGlyph({ reference }: { reference: string }) {
  const verb = actionVerb(reference);
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {verb === "process" ? <path d="m7 4 9 6-9 6Z" />
      : verb === "agent" ? <path d="m10 2 2.3 5.7L18 10l-5.7 2.3L10 18l-2.3-5.7L2 10l5.7-2.3Z" />
        : verb === "navigate" ? <path d="M3 10h13m-5-5 5 5-5 5" />
          : verb === "refresh" ? <><path d="M16 10a6 6 0 1 1-1.8-4.3" /><path d="M16 3v4h-4" /></>
            : <><circle cx="10" cy="10" r="6.5" /><circle cx="10" cy="10" r="1.8" fill="currentColor" /></>}
  </svg>;
}
