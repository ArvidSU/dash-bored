import type { ReactNode } from "react";
import type { Diagnostic } from "../../shared/contracts";

export interface DashboardEditorToolbarProps {
  diagnostics: readonly Diagnostic[];
  saving: boolean;
  dirty: boolean;
  resolving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export function DashboardEditorToolbar({ diagnostics, saving, dirty, resolving, onSave, onCancel }: DashboardEditorToolbarProps): ReactNode {
  const valid = diagnostics.every((item) => item.severity !== "error");
  return (
    <div className="editor-toolbar" role="region" aria-label="Dashboard editor">
      <div className="editor-toolbar__actions">
        {resolving ? <span role="status">Checking draft…</span> : null}
        <button className="button button--quiet" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
        <button className="button button--primary" type="button" disabled={saving || resolving || !dirty || !valid} onClick={onSave}>{saving ? "Saving…" : "Save dashboard"}</button>
      </div>
    </div>
  );
}
