import type { ReactNode } from "react";

export function EmptyProject({
  pending,
  onChoose,
}: {
  pending: boolean;
  onChoose: () => void;
}): ReactNode {
  return (
    <main className="welcome">
      <div className="welcome__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="eyebrow">Local-first project cockpit</span>
      <h1>Put the project in front of you.</h1>
      <p>
        Choose a project folder to load its workflows, status, and tools into one
        focused workspace. Missing <code>dash-bored/</code> files are created for you.
      </p>
      <button className="button button--primary button--large" type="button" disabled={pending} onClick={onChoose}>
        {pending ? "Opening…" : "Choose a project"}
      </button>
    </main>
  );
}
