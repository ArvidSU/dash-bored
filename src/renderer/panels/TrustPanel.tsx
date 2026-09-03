import type { ReactNode } from "react";
import type { ProjectSnapshot } from "../../shared/contracts";
import { hasLocalNode, PERMISSION_LABELS } from "../lib/action-providers";

export function TrustPanel({
  snapshot,
  pending,
  onTrust,
}: {
  snapshot: ProjectSnapshot;
  pending: boolean;
  onTrust: () => void;
}): ReactNode {
  const localCode = hasLocalNode(snapshot.tree);
  return (
    <section className="trust-panel" aria-labelledby="trust-title">
      <div className="trust-panel__icon" aria-hidden="true">◇</div>
      <div className="trust-panel__content">
        <span className="eyebrow">Project trust</span>
        <h2 id="trust-title">Review this project before enabling capabilities</h2>
        <p>
          Passive layout and content are visible now. Trusting enables only the
          capabilities declared by this project.
        </p>
        <ul className="permission-list">
          {localCode ? <li>Load local component code</li> : null}
          {snapshot.requestedPermissions.map((permission) => (
            <li key={permission}>{PERMISSION_LABELS[permission]}</li>
          ))}
          {!localCode && snapshot.requestedPermissions.length === 0 ? (
            <li>No privileged capabilities requested</li>
          ) : null}
        </ul>
      </div>
      <button className="button button--primary" type="button" disabled={pending} onClick={onTrust}>
        {pending ? "Enabling…" : "Trust project"}
      </button>
    </section>
  );
}
