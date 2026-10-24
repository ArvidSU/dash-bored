import { ScreenCaptureSettings } from "./ScreenCaptureSettings";
import { UpdatesPanel } from "./UpdatesPanel";
import { PackageUpdatesPanel } from "./PackageUpdatesPanel";
import { pendingUpdateCount } from "../lib/update-actions";
import { ThemeManager } from "./ThemeManager";
import { ThemeSelect } from "../lib/theme";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings, DashboardConfig, DashboardSettingsItem, ProjectListItem } from "../../shared/contracts";
import type { AgentCommandOptions } from "../../shared/agent-session";
import { keyboardShortcutFromEvent, keyboardShortcutLabel } from "../../shared/keyboard-shortcut";
import { rankActions } from "../lib/actions";
import type { PaletteAction } from "../lib/actions";
import {
  commandForPickerValue,
  detectedPickerValue,
  settingsPickerValue,
  storeCustomAgentCommand,
  storedCustomAgentCommand,
  type AgentPickerValue,
} from "../lib/agent-options";
import { host } from "../lib/rpc-client";
import { NotificationSettingsCard } from "./Notifications";

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

type SettingsAgentValue = AgentPickerValue | "bundle";

/**
 * The app-wide agent: each dashboard's own choice (null), a detected known
 * agent, or a custom ACP command. Always shows the command that will run.
 */
function AgentSettings({
  setting,
  options,
  saving,
  onSave,
  onToggle,
  enabledIds,
}: {
  setting: string | null;
  options: AgentCommandOptions | null;
  saving: boolean;
  onSave: (command: string | null) => void;
  onToggle: (id: string, enabled: boolean, options: AgentCommandOptions) => void;
  enabledIds?: readonly string[];
}): ReactNode {
  const [refreshed, setRefreshed] = useState<AgentCommandOptions | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useEffect(() => setRefreshed(null), [options]);
  options = refreshed ?? options;
  const [value, setValue] = useState<SettingsAgentValue>(() => settingsPickerValue(setting, options));
  const [custom, setCustom] = useState(() => (
    settingsPickerValue(setting, options) === "custom" && setting !== null ? setting : storedCustomAgentCommand()
  ));
  // The saved setting and detection are authoritative once they (re)load.
  useEffect(() => {
    const next = settingsPickerValue(setting, options);
    setValue(next);
    if (next === "custom" && setting !== null) setCustom(setting);
  }, [setting, options]);

  const draft: string | null = value === "bundle" ? null : commandForPickerValue(value, options, custom);
  const invalid = draft !== null && draft === "";
  const unchanged = draft === (setting?.trim() ?? null);
  const firstDetected = options?.detected[0] ?? null;

  return (
    <section className="settings-card settings-card--agent" aria-labelledby="agent-settings-title">
      <div>
        <h2 id="agent-settings-title">Dashboard agent</h2>
        <p>
          Choose the <abbr title="Agent Client Protocol">ACP</abbr> agent that Change with agent, agent prompts, and
          dashboard setup start. This app-wide choice overrides each dashboard&apos;s <code>DASH_BORED_AGENT</code>.
          Check the agents you want to use. Installed agents are used directly; supported packages download
          on first use. Signing in belongs to the agent.
        </p>
      </div>
      <form className="settings-agent" onSubmit={(event) => {
        event.preventDefault();
        if (invalid || unchanged) return;
        if (value === "custom") storeCustomAgentCommand(custom.trim());
        onSave(draft);
      }}>
        <label htmlFor="dash-bored-agent">Agent</label>
        <div className="settings-agent__controls">
          <select
            id="dash-bored-agent"
            value={value}
            disabled={saving}
            onChange={(event) => setValue(event.target.value as SettingsAgentValue)}
          >
            <option value="bundle">Each dashboard&apos;s choice</option>
            {options && options.detected.length > 0 ? (
              <optgroup label="Enabled agents">
                {options.detected.map((agent) => (
                  <option key={agent.id} value={detectedPickerValue(agent.id)}>{agent.name}</option>
                ))}
              </optgroup>
            ) : null}
            <option value="custom">Custom command</option>
          </select>
          <button className="button button--secondary" type="submit" disabled={saving || invalid || unchanged}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {value === "custom" ? (
          <input
            type="text"
            aria-label="Custom agent command"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={1_024}
            placeholder="gemini --acp"
            value={custom}
            disabled={saving}
            onChange={(event) => setCustom(event.target.value)}
          />
        ) : null}
        <span className="settings-agent__hint" aria-live="polite">
          {value === "bundle" ? (
            <>
              Uses each dashboard&apos;s <code>.env</code> <code>DASH_BORED_AGENT</code>, else the first enabled agent
              {firstDetected ? <> (now <code>{firstDetected.command}</code>)</> : null}.
            </>
          ) : draft ? (
            <>Runs <code>{draft}</code> from the project root.</>
          ) : (
            "Enter an ACP launch command, such as gemini --acp."
          )}
        </span>
      </form>
      <div className="settings-agent-catalog">
        <div className="settings-agent-catalog__heading">
          <div><h3>Enabled agents</h3><p>Changes save automatically. Unchecking leaves installed software in place.</p></div>
          <button type="button" className="button button--quiet" disabled={refreshing || saving} onClick={async () => {
            setRefreshing(true);
            setRefreshError(null);
            try { setRefreshed(await host.getAgentOptions()); }
            catch { setRefreshError("Could not refresh agents. Try again."); }
            finally { setRefreshing(false); }
          }}>{refreshing ? "Refreshing…" : "Refresh agents"}</button>
        </div>
        {options ? <ul className="settings-agent-catalog__list">
          {options.known.map((agent) => {
            const setup = options.setup?.find((item) => item.id === agent.id);
            const enabled = enabledIds ? enabledIds.includes(agent.id) : setup?.enabled ?? options.detected.some((item) => item.id === agent.id);
            const installed = setup?.installed ?? enabled;
            return <li key={agent.id}>
              <label className="settings-agent-catalog__choice">
                <input type="checkbox" aria-label={`Enable ${agent.name}`} checked={enabled} disabled={saving || refreshing}
                  onChange={(event) => onToggle(agent.id, event.target.checked, options!)} />
                <span><strong>{agent.name}</strong><span className="settings-agent-catalog__status">
                  {installed ? "Installed" : setup?.command ? "Downloads on first use" : setup?.needs ?? "Install the agent, then refresh."}
                </span></span>
              </label>
              <a href={agent.homepage} target="_blank" rel="noreferrer" aria-label={`${agent.name} setup instructions`}>Setup ↗</a>
              <code>{setup?.command ?? agent.command}</code>
            </li>;
          })}
        </ul> : <p role="status">Loading agents…</p>}
        {options && options.detected.length === 0 ? <p role="status">No enabled agent is ready. Check an agent above or finish its setup.</p> : null}
        {refreshError ? <p role="alert">{refreshError}</p> : null}
      </div>
    </section>
  );
}

export type SettingsTab = "general" | "themes" | "actions" | "updates";

export function SettingsPanel({
  updates,
  packageUpdates,
  activeTab,
  onSelectTab: setActiveTab,
  draftsOpen = false,
  appSettings,
  dashboardSettings,
  projects = [],
  actions,
  pendingAction,
  agentOptions = null,
  onSaveAgent,
  onUpdateSettings,
  onUpdateDashboardAppearance,
}: {
  updates: import("../app/use-app-updates").AppUpdatesController;
  packageUpdates: import("../app/use-package-updates").PackageUpdatesController;
  activeTab: SettingsTab;
  onSelectTab(tab: SettingsTab): void;
  draftsOpen?: boolean;
  appSettings: AppSettings;
  dashboardSettings: readonly DashboardSettingsItem[];
  /** Registered dashboards, for per-dashboard notification levels. */
  projects?: readonly ProjectListItem[];
  actions: readonly PaletteAction[];
  pendingAction: string | null;
  /** Detected and known agents for the agent picker; null while loading. */
  agentOptions?: AgentCommandOptions | null;
  onSaveAgent: (command: string | null) => void;
  onUpdateSettings: (settings: AppSettings, notice: string) => void;
  onUpdateDashboardAppearance: (dashboard: DashboardSettingsItem, change: Pick<DashboardConfig, "theme" | "themeMode">) => Promise<void>;
}): ReactNode {
  const [actionQuery, setActionQuery] = useState("");
  const [updatingDashboard, setUpdatingDashboard] = useState<string | null>(null);
  const savingSettings = pendingAction === "save-settings";
  const pendingUpdates = pendingUpdateCount(updates.state, packageUpdates.state);
  const favoriteIds = useMemo(() => new Set(appSettings.favoriteActionIds), [appSettings.favoriteActionIds]);
  const visibleActions = useMemo(
    () => rankActions(actions, actionQuery, favoriteIds, true),
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

  async function updateDashboardAppearance(
    dashboard: DashboardSettingsItem,
    change: Pick<DashboardConfig, "theme" | "themeMode">,
  ): Promise<void> {
    setUpdatingDashboard(dashboard.configPath);
    try {
      await onUpdateDashboardAppearance(dashboard, change);
    } finally {
      setUpdatingDashboard((current) => current === dashboard.configPath ? null : current);
    }
  }

  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div className="settings-page__heading">
        <span className="eyebrow">Application</span>
        <h1 id="settings-title">Settings</h1>
        <p>Configure app behavior, appearance, action favorites, and keyboard shortcuts.</p>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" aria-selected={activeTab === "general"} onClick={() => setActiveTab("general")}>General</button>
        <button type="button" role="tab" aria-selected={activeTab === "themes"} onClick={() => setActiveTab("themes")}>Themes</button>
        <button type="button" role="tab" aria-selected={activeTab === "actions"} onClick={() => setActiveTab("actions")}>Actions</button>
        <button type="button" role="tab" aria-selected={activeTab === "updates"} onClick={() => setActiveTab("updates")}
          aria-describedby={pendingUpdates ? "settings-updates-count" : undefined}>
          Updates{pendingUpdates ? <span className="settings-tabs__badge" aria-hidden="true">{pendingUpdates}</span> : null}
        </button>
        {pendingUpdates ? <span id="settings-updates-count" hidden>{pendingUpdates} available</span> : null}
      </div>
      {activeTab === "updates" && <div className="settings-tab-panel" role="tabpanel" aria-label="Updates">
        <UpdatesPanel draftsOpen={draftsOpen} updates={updates} />
        <PackageUpdatesPanel packages={packageUpdates} automaticChecks={updates.state?.settings.automaticChecks} />
      </div>}
      {activeTab === "themes" && <div className="settings-tab-panel" role="tabpanel" aria-label="Themes">
      <section className="settings-card settings-card--themes" aria-labelledby="theme-settings-title">
        <h2 id="theme-settings-title">App defaults</h2>
        <label className="props-field"><span>Default theme</span><ThemeSelect appDefault value={appSettings.theme} onChange={(theme) => onUpdateSettings({ ...appSettings, theme }, "Default theme updated.")} /></label>
        <label className="props-field"><span>Appearance</span><select aria-label="Appearance" value={appSettings.themeMode ?? 'dark'} onChange={(event) => onUpdateSettings({ ...appSettings, themeMode: event.target.value as 'light' | 'dark' | 'system' }, "Appearance updated.")}>
          <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
        </select></label>
        <p>Dashboards inherit these settings until you choose a different appearance below.</p>
      </section>
      <section className="settings-card settings-card--themes settings-card--dashboard-list" aria-labelledby="dashboard-theme-settings-title">
        <h2 id="dashboard-theme-settings-title">Dashboard appearances</h2>
        <p>Choose each dashboard’s theme and appearance independently. Blank selections inherit the app defaults.</p>
        <div className="dashboard-settings-list">
          {dashboardSettings.map((dashboard) => {
            const label = dashboard.dashboardName?.trim() || dashboard.configPath;
            const updating = updatingDashboard === dashboard.configPath;
            return <article className="dashboard-settings" key={dashboard.configPath} aria-label={`Appearance settings for ${label}`}>
              <div className="dashboard-settings__identity">
                <strong>{dashboard.dashboardName?.trim() || "Unnamed dashboard"}</strong>
                <code title={dashboard.configPath}>{dashboard.configPath}</code>
                {dashboard.error ? <span className="dashboard-settings__error" role="alert">{dashboard.error}</span> : null}
              </div>
              {!dashboard.error ? <div className="dashboard-settings__controls">
                <label className="props-field"><span>Theme</span><ThemeSelect
                  ariaLabel={`Theme for ${label}`}
                  dashboardConfigPath={dashboard.configPath}
                  inherit
                  value={dashboard.theme}
                  onChange={(theme) => void updateDashboardAppearance(dashboard, { theme: theme || undefined })}
                /></label>
                <label className="props-field"><span>Appearance</span><select
                  aria-label={`Appearance for ${label}`}
                  disabled={updating}
                  value={dashboard.themeMode ?? ""}
                  onChange={(event) => void updateDashboardAppearance(dashboard, { themeMode: (event.target.value || undefined) as DashboardConfig["themeMode"] })}
                >
                  <option value="">Use app default</option><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
                </select></label>
              </div> : null}
              {updating ? <span className="dashboard-settings__status">Saving…</span> : null}
            </article>;
          })}
          {dashboardSettings.length === 0 ? <p>No registered dashboards yet.</p> : null}
        </div>
      </section>
      <ThemeManager dashboards={dashboardSettings} />
      </div>}
      {activeTab === "general" ? <div className="settings-tab-panel" role="tabpanel">
      <section className="settings-card" aria-labelledby="palette-settings-title">
        <div>
          <h2 id="palette-settings-title">Command palette</h2>
          <p>Open the searchable action list from anywhere in the app.</p>
          <p>Hold Command when running an action (⌘Enter or ⌘click) to keep the palette open.</p>
        </div>
        <div className="settings-palette-controls">
          <ShortcutRecorder
            label="Command palette"
            shortcut={appSettings.commandPaletteShortcut}
            disabled={savingSettings}
            onChange={updatePaletteShortcut}
          />
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={appSettings.clearPaletteInputOnKeepOpen}
              disabled={savingSettings}
              onChange={(event) => onUpdateSettings(
                { ...appSettings, clearPaletteInputOnKeepOpen: event.target.checked },
                event.target.checked ? "Keep-open actions will clear the palette search." : "Keep-open actions will preserve the palette search.",
              )}
            />
            <span>Clear search when keeping the palette open</span>
          </label>
        </div>
      </section>
      <section className="settings-card" aria-labelledby="sidebar-settings-title">
        <div>
          <h2 id="sidebar-settings-title">Dashboard sidebar</h2>
          <p>Choose whether configured dashboard names are visible when dash-bored opens.</p>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={appSettings.sidebarExpandedByDefault}
            disabled={savingSettings}
            onChange={(event) => onUpdateSettings(
              { ...appSettings, sidebarExpandedByDefault: event.target.checked },
              event.target.checked ? "Sidebar will start expanded." : "Sidebar will start collapsed.",
            )}
          />
          <span>Start expanded</span>
        </label>
      </section>
      <NotificationSettingsCard
        settings={appSettings}
        projects={projects}
        disabled={savingSettings}
        onUpdate={onUpdateSettings}
      />
      <ScreenCaptureSettings />
      <AgentSettings
        setting={appSettings.dashBoredAgent}
        options={agentOptions}
        saving={savingSettings}
        onSave={onSaveAgent}
        enabledIds={appSettings.enabledAgentIds}
        onToggle={(id, enabled, options) => {
          const ids = new Set(appSettings.enabledAgentIds ?? options.setup?.filter((item) => item.enabled).map((item) => item.id) ?? options.detected.map((item) => item.id));
          if (enabled) ids.add(id); else ids.delete(id);
          const known = options.known.find((item) => item.id === id);
          const command = options.setup?.find((item) => item.id === id)?.command;
          const clearDefault = !enabled && (appSettings.dashBoredAgent === command || appSettings.dashBoredAgent === known?.command);
          onUpdateSettings({ ...appSettings, enabledAgentIds: [...ids], ...(clearDefault ? { dashBoredAgent: null } : {}) },
            `${known?.name ?? "Agent"} ${enabled ? "enabled" : "disabled"}.${clearDefault ? " App default cleared." : ""}`);
        }}
      />
      </div> : activeTab === "actions" ? (
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
      ) : null}
    </main>
  );
}
