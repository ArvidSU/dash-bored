import type { ReactNode } from "react";
import type { ProjectSnapshot } from "../../shared/contracts";
import { watchSummaries } from "../../shared/watches";
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
  const localCode = snapshot.trustReview?.hasLocalCode ?? hasLocalNode(snapshot.tree);
  const canReviewCapabilities = snapshot.trustReview?.available ?? snapshot.tree !== null;
  // Trust review lists what each watch runs and how often; linked bundles run theirs under their own trust.
  const watches = watchSummaries(snapshot.tree, snapshot.configPath ?? undefined);
  const linkedWatches = watchSummaries(snapshot.tree).length - watches.length;
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
          {!canReviewCapabilities ? (
            <li>Requested capabilities could not be inspected</li>
          ) : !localCode && snapshot.requestedPermissions.length === 0 ? (
            <li>No privileged capabilities requested</li>
          ) : null}
        </ul>
        {watches.length > 0 ? (
          <div className="trust-panel__watches" role="group" aria-label="Background watches">
            <p>Background watches keep running while this dashboard is hidden or not selected:</p>
            {watches.map((watch) => (
              <p key={watch.nodeId}>
                <strong>{watch.label}</strong> {watch.description}; notifies on {watch.on.join(", ")}
                {watch.action ? ` and offers ${watch.action}` : ""}.
              </p>
            ))}
          </div>
        ) : null}
        {linkedWatches > 0 ? (
          <p>Linked dashboards declare {linkedWatches} more watch{linkedWatches === 1 ? "" : "es"}; they run only when those dashboards are added and trusted themselves.</p>
        ) : null}
        {!canReviewCapabilities ? (
          <p>Fix the fatal configuration diagnostics before trusting this project. Fix with agent repairs them without a trust grant; nothing this project declares runs until you approve it.</p>
        ) : snapshot.tree === null ? (
          <p>You can trust this project to fix its diagnostics with your agent. The dashboard will load once those issues are fixed.</p>
        ) : null}
      </div>
      <button
        className="button button--primary"
        type="button"
        disabled={pending || !canReviewCapabilities}
        title={!canReviewCapabilities ? "Requested capabilities could not be inspected." : undefined}
        onClick={onTrust}
      >
        {pending ? "Enabling…" : "Trust project"}
      </button>
    </section>
  );
}
