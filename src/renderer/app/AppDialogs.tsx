import type { ReactNode } from "react";
import type {
  DashboardConfig,
  ProjectDeletionPreview,
  ProjectListItem,
  ResolvedComponentNode,
} from "../../shared/contracts";
import { ComponentDialog, EditorModal } from "../composition/DashboardEditor";
import type { InsertionTarget, NodePath } from "../composition/dashboard-editor";
import { catalogManifest, countNodes, nodeAtPath } from "../composition/dashboard-editor";
import { projectLabel } from "../lib/action-providers";
import { basename } from "./app-utils";
import type { DashboardEditSession } from "./app-utils";
import type { CompositionDialogState } from "../composition/composition-interaction-controller";
import { AgentPromptPanel } from "../panels/AgentPromptPanel";

export interface AppDialogsProps {
  compositionDialog: CompositionDialogState | null;
  compositionRemovePath: NodePath | null;
  editSession: DashboardEditSession | null;
  editingActiveProject: boolean;
  agentDialog: ResolvedComponentNode | null;
  pendingAction: string | null;
  discardConfirmation: { message: string; continueAction: () => void } | null;
  deletionDialog: {
    project: ProjectListItem;
    preview: ProjectDeletionPreview;
    removeFiles: boolean;
  } | null;
  agentCommand: string;
  agentCreatePending: boolean;
  onApplyCompositionDraft: (next: DashboardConfig) => void;
  onDismissCompositionDialog: () => void;
  onDismissRemoval: () => void;
  onConfirmRemoval: () => void;
  onBuildWithAgent: (target: InsertionTarget, description: string) => void;
  onRunComponentAgent: (node: ResolvedComponentNode, prompt: string) => Promise<void>;
  onDismissAgentDialog: () => void;
  onDismissDiscard: () => void;
  onConfirmDiscard: (continueAction: () => void) => void;
  onDismissDeletion: () => void;
  onToggleDeletionFiles: (removeFiles: boolean) => void;
  onConfirmDeletion: () => void;
}

/** All dashboard modals: composition dialogs, removal, agent, discard, deletion. */
export function AppDialogs({
  compositionDialog,
  compositionRemovePath,
  editSession,
  editingActiveProject,
  agentDialog,
  pendingAction,
  discardConfirmation,
  deletionDialog,
  agentCommand,
  agentCreatePending,
  onApplyCompositionDraft,
  onDismissCompositionDialog,
  onDismissRemoval,
  onConfirmRemoval,
  onBuildWithAgent,
  onRunComponentAgent,
  onDismissAgentDialog,
  onDismissDiscard,
  onConfirmDiscard,
  onDismissDeletion,
  onToggleDeletionFiles,
  onConfirmDeletion,
}: AppDialogsProps): ReactNode {
  const compositionExisting = compositionDialog?.mode === "configure"
    && editSession
    && compositionDialog.path
    ? (() => {
        try {
          return { path: compositionDialog.path, node: nodeAtPath(editSession.draft.root, compositionDialog.path) };
        } catch {
          return null;
        }
      })()
    : null;
  const compositionRemoving = compositionRemovePath && editSession
    ? (() => {
        try {
          return nodeAtPath(editSession.draft.root, compositionRemovePath);
        } catch {
          return null;
        }
      })()
    : null;

  return (
    <>
  {compositionDialog && editSession && editingActiveProject && compositionDialog.mode === "configure" && compositionExisting ? (
    <ComponentDialog
      catalog={editSession.componentCatalog}
      config={editSession.draft}
      existing={compositionExisting}
      onApply={onApplyCompositionDraft}
      onDismiss={onDismissCompositionDialog}
    />
  ) : null}
  {compositionDialog && editSession && editingActiveProject && compositionDialog.mode === "replace" ? (
    <ComponentDialog
      catalog={editSession.componentCatalog}
      config={editSession.draft}
      replace={editSession.draft.root}
      initialReference={compositionDialog.reference}
      onApply={onApplyCompositionDraft}
      onDismiss={onDismissCompositionDialog}
    />
  ) : null}
  {compositionDialog && editSession && editingActiveProject && compositionDialog.mode === "add" && compositionDialog.target ? (
    <ComponentDialog
      catalog={editSession.componentCatalog}
      config={editSession.draft}
      target={compositionDialog.target}
      initialReference={compositionDialog.reference}
      projectRoot={editSession.projectRoot}
      configPath={editSession.configPath}
      agentCommand={agentCommand}
      agentPending={agentCreatePending}
      onBuildWithAgent={onBuildWithAgent}
      onApply={onApplyCompositionDraft}
      onDismiss={onDismissCompositionDialog}
    />
  ) : null}
  {compositionRemovePath && compositionRemoving && editSession && editingActiveProject ? (
    <EditorModal title="Remove component?" onDismiss={onDismissRemoval}>
      <div className="remove-confirmation">
        <p>Remove <strong>{catalogManifest(editSession.componentCatalog, compositionRemoving.component)?.name ?? compositionRemoving.component}</strong>?</p>
        {countNodes(compositionRemoving) > 1 ? <p>This also removes {countNodes(compositionRemoving) - 1} nested components.</p> : null}
        <p>The change remains recoverable until you save the dashboard.</p>
        <footer className="editor-modal__actions">
          <button className="button button--quiet" type="button" onClick={onDismissRemoval}>Cancel</button>
          <button className="button button--danger" type="button" onClick={onConfirmRemoval}>Remove</button>
        </footer>
      </div>
    </EditorModal>
  ) : null}
  {agentDialog ? (
    <EditorModal
      title={`Change ${agentDialog.configName?.trim() || agentDialog.manifest?.name || agentDialog.component}`}
      onDismiss={() => {
        if (pendingAction !== `component-agent:${agentDialog.id}`) onDismissAgentDialog();
      }}
    >
      <AgentPromptPanel
        key={agentDialog.id}
        node={agentDialog}
        agentCommand={agentCommand}
        pending={pendingAction === `component-agent:${agentDialog.id}`}
        onDismiss={() => onDismissAgentDialog()}
        onSend={(prompt) => onRunComponentAgent(agentDialog, prompt)}
      />
    </EditorModal>
  ) : null}
  {discardConfirmation ? (
    <EditorModal title="Discard dashboard changes?" onDismiss={() => onDismissDiscard()}>
      <div className="remove-confirmation">
        <p>{discardConfirmation.message}</p>
        <p>This draft has not been written to dash-bored.yaml.</p>
        <footer className="editor-modal__actions">
          <button className="button button--quiet" type="button" onClick={() => onDismissDiscard()}>Keep editing</button>
          <button className="button button--danger" type="button" onClick={() => onConfirmDiscard(discardConfirmation.continueAction)}>Discard changes</button>
        </footer>
      </div>
    </EditorModal>
  ) : null}
  {deletionDialog ? (
    <EditorModal title="Remove dashboard?" onDismiss={() => onDismissDeletion()}>
      <div className="remove-confirmation dashboard-delete-confirmation">
        <p>
          Remove <strong>{projectLabel(deletionDialog.project)}</strong> from the dash-bored sidebar?
          The dashboard entry is removed by default; its project files stay on disk.
        </p>

        {deletionDialog.preview.dependencies.length > 0 ? (
          <section className="dashboard-delete-dependencies" aria-labelledby="dashboard-delete-dependencies-title">
            <h3 id="dashboard-delete-dependencies-title">Dashboards that use these files</h3>
            <p>
              These links may stop working if the app-owned project files are moved to Trash.
            </p>
            <ul>
              {deletionDialog.preview.dependencies.map((dependency) => (
                <li key={dependency.projectRoot}>
                  <strong>{dependency.dashboardName?.trim() || basename(dependency.projectRoot)}</strong>
                  <ul>
                    {dependency.configPaths.map((configPath) => <li key={configPath}><code>{configPath}</code></li>)}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {!deletionDialog.preview.analysisComplete ? (
          <section className="dashboard-delete-issues" role="alert">
            <strong>File removal is unavailable</strong>
            <p>
              dash-bored could not safely complete dependency analysis, so the project files cannot be moved to Trash from this dialog.
            </p>
            <ul>
              {deletionDialog.preview.analysisIssues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          </section>
        ) : null}

        {deletionDialog.preview.filesExist ? (
          <label className={`dashboard-delete-files-option${deletionDialog.removeFiles ? " dashboard-delete-files-option--selected" : ""}`}>
            <input
              type="checkbox"
              checked={deletionDialog.removeFiles}
              disabled={!deletionDialog.preview.analysisComplete}
              onChange={(event) => onToggleDeletionFiles(event.target.checked)}
            />
            <span>
              <strong>Also move project files to Trash</strong>
              <small>Moves only {deletionDialog.preview.filesDirectory} and its nested dash-bored bundles, components, locks, and environment files.</small>
            </span>
          </label>
        ) : (
          <p className="dashboard-delete-no-files">No app-owned dash-bored/ directory was found, so only the sidebar entry will be removed.</p>
        )}

        {deletionDialog.removeFiles ? (
          <section className="dashboard-delete-warning" role="alert">
            <strong>Project files will be moved to the OS Trash.</strong>
            <p>This removes the dashboard’s app-owned files and can break the links listed above. Source project files outside dash-bored/ are never touched.</p>
          </section>
        ) : null}

        <footer className="editor-modal__actions">
          <button className="button button--quiet" data-modal-close type="button" onClick={() => onDismissDeletion()}>Cancel</button>
          <button
            className="button button--danger"
            type="button"
            disabled={deletionDialog.removeFiles && !deletionDialog.preview.analysisComplete}
            onClick={() => onConfirmDeletion()}
          >
            {deletionDialog.removeFiles ? "Move files to Trash & remove" : "Remove dashboard"}
          </button>
        </footer>
      </div>
    </EditorModal>
  ) : null}

    </>
  );
}
