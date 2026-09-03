import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings, ProjectSnapshot } from "../../shared/contracts";
import { keyboardShortcutFromEvent, keyboardShortcutLabel } from "../../shared/keyboard-shortcut";
import { rankActions } from "../lib/actions";
import type { PaletteAction } from "../lib/actions";
import { basename } from "../app/app-utils";

function ShortcutRecorder({
  shortcut,
  label,
  disabled = false,
  onChange,
}: {
  shortcut: string | null;
  label: string;
  disabled?: boolean;
  onChange: (shortcut: string | null) => void;
}): ReactNode {
  const [listening, setListening] = useState(false);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  function capture(event: Pick<globalThis.KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "preventDefault" | "stopPropagation">): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setListening(false);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      onChange(null);
      setListening(false);
      return;
    }
    const next = keyboardShortcutFromEvent(event);
    if (!next) return;
    onChange(next);
    setListening(false);
  }

  useEffect(() => {
    if (!listening) return;
    const captureNextShortcut = (event: globalThis.KeyboardEvent): void => capture(event);
    window.addEventListener("keydown", captureNextShortcut, true);
    return () => window.removeEventListener("keydown", captureNextShortcut, true);
  }, [listening, onChange]);

  return (
    <button
      className={`shortcut-recorder${listening ? " shortcut-recorder--listening" : ""}`}
      type="button"
      disabled={disabled}
      aria-label={`${label} shortcut: ${keyboardShortcutLabel(shortcut, mac)}`}
      title={listening ? "Press a key combination; Escape cancels and Delete clears" : "Change keyboard shortcut"}
      onClick={(event) => {
        event.currentTarget.focus();
        setListening((current) => !current);
      }}
      onBlur={() => setListening(false)}
    >
      {listening ? "Press keys…" : keyboardShortcutLabel(shortcut, mac)}
    </button>
  );
}

export function SettingsPanel({
  snapshot,
  appSettings,
  actions,
  pendingAction,
  onSaveAgent,
  onUpdateSettings,
  onReload,
  onTrust,
  onRevoke,
}: {
  snapshot: ProjectSnapshot | null;
  appSettings: AppSettings;
  actions: readonly PaletteAction[];
  pendingAction: string | null;
  onSaveAgent: (command: string) => void;
  onUpdateSettings: (settings: AppSettings, notice: string) => void;
  onReload: () => void;
  onTrust: () => void;
  onRevoke: () => void;
}): ReactNode {
  const [agentDraft, setAgentDraft] = useState(appSettings.dashBoredAgent);
  const [activeTab, setActiveTab] = useState<"general" | "actions">("general");
  const [actionQuery, setActionQuery] = useState("");
  useEffect(() => setAgentDraft(appSettings.dashBoredAgent), [appSettings.dashBoredAgent]);
  const normalizedAgentDraft = agentDraft.trim();
  const savingSettings = pendingAction === "save-settings";
  const favoriteIds = useMemo(() => new Set(appSettings.favoriteActionIds), [appSettings.favoriteActionIds]);
  const visibleActions = useMemo(
    () => rankActions(actions, actionQuery, favoriteIds),
    [actionQuery, actions, favoriteIds],
  );

  function updatePaletteShortcut(shortcut: string | null): void {
    const actionShortcuts = { ...appSettings.actionShortcuts };
    if (shortcut) {
      for (const [id, assigned] of Object.entries(actionShortcuts)) {
        if (assigned === shortcut) delete actionShortcuts[id];
      }
    }
    onUpdateSettings(
      { ...appSettings, commandPaletteShortcut: shortcut, actionShortcuts },
      shortcut ? "Command palette shortcut updated." : "Command palette shortcut cleared.",
    );
  }

  function updateActionShortcut(id: string, shortcut: string | null): void {
    const actionShortcuts = { ...appSettings.actionShortcuts };
    if (shortcut) {
      for (const [assignedId, assigned] of Object.entries(actionShortcuts)) {
        if (assigned === shortcut) delete actionShortcuts[assignedId];
      }
      actionShortcuts[id] = shortcut;
    } else {
      delete actionShortcuts[id];
    }
    onUpdateSettings(
      {
        ...appSettings,
        commandPaletteShortcut: shortcut && shortcut === appSettings.commandPaletteShortcut
          ? null
          : appSettings.commandPaletteShortcut,
        actionShortcuts,
      },
      shortcut ? "Action shortcut updated." : "Action shortcut cleared.",
    );
  }

  function toggleFavorite(id: string): void {
    const favoriteActionIds = favoriteIds.has(id)
      ? appSettings.favoriteActionIds.filter((candidate) => candidate !== id)
      : [...appSettings.favoriteActionIds, id];
    onUpdateSettings(
      { ...appSettings, favoriteActionIds },
      favoriteIds.has(id) ? "Action removed from favorites." : "Action added to favorites.",
    );
  }

  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div className="settings-page__heading">
        <span className="eyebrow">Application</span>
        <h1 id="settings-title">Settings</h1>
        <p>Configure app behavior, action favorites, and keyboard shortcuts.</p>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" aria-selected={activeTab === "general"} onClick={() => setActiveTab("general")}>General</button>
        <button type="button" role="tab" aria-selected={activeTab === "actions"} onClick={() => setActiveTab("actions")}>Actions</button>
      </div>
      {activeTab === "general" ? <div className="settings-tab-panel" role="tabpanel">
      <section className="settings-card" aria-labelledby="palette-settings-title">
        <div>
          <h2 id="palette-settings-title">Command palette</h2>
          <p>Open the searchable action list from anywhere in the app.</p>
        </div>
        <ShortcutRecorder
          label="Command palette"
          shortcut={appSettings.commandPaletteShortcut}
          disabled={savingSettings}
          onChange={updatePaletteShortcut}
        />
      </section>
      <section className="settings-card" aria-labelledby="sidebar-settings-title">
        <div>
          <h2 id="sidebar-settings-title">Dashboard sidebar</h2>
          <p>The sidebar starts collapsed each time dash-bored opens. Expand it to see configured dashboard names.</p>
        </div>
        <span className="settings-value">Collapsed by default</span>
      </section>
      <section className="settings-card settings-card--agent" aria-labelledby="agent-settings-title">
        <div>
          <h2 id="agent-settings-title">Dashboard agent</h2>
          <p>Set the app-wide <code>DASH_BORED_AGENT</code> command used by every component’s Change with agent action.</p>
        </div>
        <form className="settings-agent" onSubmit={(event) => {
          event.preventDefault();
          if (normalizedAgentDraft) onSaveAgent(normalizedAgentDraft);
        }}>
          <label htmlFor="dash-bored-agent">DASH_BORED_AGENT</label>
          <div className="settings-agent__controls">
            <input
              id="dash-bored-agent"
              type="text"
              spellCheck={false}
              maxLength={1_024}
              value={agentDraft}
              disabled={savingSettings}
              onChange={(event) => setAgentDraft(event.target.value)}
            />
            <button
              className="button button--secondary"
              type="submit"
              disabled={savingSettings || !normalizedAgentDraft || normalizedAgentDraft === appSettings.dashBoredAgent}
            >
              {savingSettings ? "Saving…" : "Save"}
            </button>
          </div>
          <span>Example: <code>{normalizedAgentDraft || "codex exec"} &quot;Change this thing&quot;</code></span>
        </form>
      </section>
      <section className="settings-card" aria-labelledby="project-settings-title">
        <div className="settings-card__project">
          <h2 id="project-settings-title">Active dashboard</h2>
          {snapshot?.projectRoot ? (
            <>
              <strong>{snapshot.dashboardName?.trim() || basename(snapshot.projectRoot)}</strong>
              <code title={snapshot.projectRoot}>{snapshot.projectRoot}</code>
            </>
          ) : (
            <p>No dashboard is currently open.</p>
          )}
        </div>
        {snapshot?.projectRoot ? (
          <div className="settings-card__actions">
            <button className="button button--quiet" type="button" disabled={pendingAction !== null} onClick={onReload}>
              {pendingAction === "reload" ? "Reloading…" : "Reload dashboard"}
            </button>
            {snapshot.trusted ? (
              <button className="button button--danger" type="button" disabled={pendingAction !== null} onClick={onRevoke}>
                {pendingAction === "revoke" ? "Revoking…" : "Revoke trust"}
              </button>
            ) : (
              <button className="button button--primary" type="button" disabled={pendingAction !== null || snapshot.tree === null} onClick={onTrust}>
                {pendingAction === "trust" ? "Enabling…" : "Trust dashboard"}
              </button>
            )}
          </div>
        ) : null}
      </section>
      </div> : (
        <div className="settings-tab-panel settings-actions" role="tabpanel">
          <div className="settings-actions__heading">
            <div>
              <h2>Command palette actions</h2>
              <p>Favorites appear first in the palette. Search still filters the complete action list.</p>
            </div>
            <input
              type="search"
              aria-label="Search actions"
              placeholder="Search actions…"
              value={actionQuery}
              onChange={(event) => setActionQuery(event.target.value)}
            />
          </div>
          <div className="settings-actions__list">
            {visibleActions.map((action) => {
              const favorite = favoriteIds.has(action.id);
              return (
                <div className="settings-action" key={action.id}>
                  <button
                    className={`settings-action__favorite${favorite ? " settings-action__favorite--active" : ""}`}
                    type="button"
                    aria-label={`${favorite ? "Remove" : "Add"} ${action.label} ${favorite ? "from" : "to"} favorites`}
                    aria-pressed={favorite}
                    disabled={savingSettings}
                    onClick={() => toggleFavorite(action.id)}
                  >
                    <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
                  </button>
                  <div className="settings-action__copy">
                    <strong>{action.label}</strong>
                    <span>{action.description ?? action.source ?? "Ready"}</span>
                    <small>{action.group}{action.enabled ? "" : ` · ${action.disabledReason ?? "Unavailable"}`}</small>
                  </div>
                  <ShortcutRecorder
                    label={action.label}
                    shortcut={appSettings.actionShortcuts[action.id] ?? null}
                    disabled={savingSettings}
                    onChange={(shortcut) => updateActionShortcut(action.id, shortcut)}
                  />
                </div>
              );
            })}
            {visibleActions.length === 0 ? <p className="settings-actions__empty">No matching actions.</p> : null}
          </div>
        </div>
      )}
    </main>
  );
}
