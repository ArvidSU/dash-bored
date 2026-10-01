import { useEffect, useState, type ReactNode } from 'react';
import { host } from '../lib/rpc-client';
import { RELEASE_CHANNELS, type DashboardMigration, type UpdateAction, type UpdateReceipt, type UpdateState } from '../../shared/updates';

const WORKING_PHASES: UpdateState['phase'][] = ['migrating', 'verifying', 'updating-guidance'];
const SELECTABLE_CHANNELS = RELEASE_CHANNELS.filter(c => c.available);

/**
 * One headline state at a time: up to date, an update to get, or the step in
 * progress. Dashboards appear only when they need migrating.
 */
export function UpdatesPanel({ draftsOpen = false }: { draftsOpen?: boolean }): ReactNode {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => host.getUpdateState().then(s => { if (active) setState(s); }).catch(e => { if (active) setError(String(e)); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function act(action: UpdateAction): Promise<void> {
    setPending(true); setError('');
    try { const result = await host.updateAction(action); setState(old => ({ ...result, directInstallAvailable: old?.directInstallAvailable })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  }
  if (!state) return <section className="settings-card updates-panel" aria-label="Updates"><p role="status">{error || 'Loading update status…'}</p></section>;

  const receipt = state.receipt && !state.receipt.cancelled ? state.receipt : null;
  const target = state.release?.metadata.version;
  const available = Boolean(target && target !== state.currentVersion);
  const installedHere = receipt?.installation === 'installed' && receipt.release.metadata.version === state.currentVersion;
  const working = pending || state.phase === 'checking' || state.phase === 'downloading' || WORKING_PHASES.includes(state.phase);
  const attention = state.dashboards.filter(d => d.status !== 'current');
  const migratable = attention.filter(d => d.status === 'required').map(d => d.configPath);
  const chosen = selected.filter(p => migratable.includes(p));
  const toggle = (path: string, on: boolean) => setSelected(old => on ? [...old, path] : old.filter(p => p !== path));
  const problem = state.phase === 'problem' ? state.message : '';
  const footer = <UpdateFooter state={state} disabled={pending} onChange={settings => void act({ type: 'settings', settings })} />;
  const dashboards = (selectable: boolean) => attention.length > 0 && <MigrationList
    dashboards={attention} receipt={state.receipt} selected={chosen} disabled={working || !selectable} onToggle={toggle} />;
  const alerts = <>
    {error && <p className="updates-panel__alert" role="alert">{error}</p>}
    {problem && !error && <p className="updates-panel__alert" role="alert">{problem}</p>}
    {problem.includes('lock') && <button className="button button--quiet" type="button" onClick={() => void act({ type: 'recover' })}>Recover interrupted update</button>}
  </>;

  if (state.phase === 'checking') return <Shell tone="busy">
    <Hero eyebrow={`dash-bored ${state.currentVersion}`} title="Looking for something new…" />
    <Progress label="Checking for updates" />
    {footer}
  </Shell>;

  if (WORKING_PHASES.includes(state.phase)) return <Shell tone="busy">
    <Hero eyebrow={`dash-bored ${state.currentVersion}`} title="Migrating dashboards" body={state.message} />
    <Progress label="Migrating dashboards" />
    <div className="updates-panel__actions"><button className="button button--quiet" type="button" onClick={() => void act({ type: 'cancel' })}>Stop after this step</button></div>
  </Shell>;

  if (receipt?.installation === 'downloading') return <Shell tone="busy">
    <Hero eyebrow="Downloading" title={`Fetching ${receipt.release.metadata.version}…`} body="Verifying the installer as it lands." />
    <Progress label="Downloading update" />
    <div className="updates-panel__actions"><button className="button button--quiet" type="button" onClick={() => void act({ type: 'cancel' })}>Cancel</button></div>
  </Shell>;

  if (receipt && (receipt.installation === 'ready' || receipt.installation === 'awaiting-install')) {
    const version = receipt.release.metadata.version;
    const blocked = working || draftsOpen;
    return <Shell tone="fresh">
      <Hero eyebrow="Ready to install" title={`${version} is downloaded`} version={version}
        body={state.directInstallAvailable ? 'dash-bored restarts straight into the new version. Running terminals and agent work must finish first; nothing is stopped for you.' : 'Open the verified installer, quit dash-bored, replace the app, then open it again. macOS may ask you to choose Open Anyway.'} />
      {receipt.selected.length > 0 && <p className="updates-panel__note">{plural(receipt.selected.length, 'dashboard')} will migrate after the restart.</p>}
      {draftsOpen && <p className="updates-panel__alert" role="alert">Save or cancel the open dashboard draft before installing.</p>}
      {alerts}
      <div className="updates-panel__actions">
        {state.directInstallAvailable
          ? <><button className="button button--primary button--large" type="button" disabled={blocked} onClick={() => void act({ type: 'install' })}>Restart and install</button>
            <button className="button button--quiet" type="button" disabled={blocked} onClick={() => void act({ type: 'install', method: 'dmg' })}>Use the installer instead</button></>
          : <button className="button button--primary button--large" type="button" disabled={blocked} onClick={() => void act({ type: 'install', method: 'dmg' })}>Open installer</button>}
        <button className="button button--quiet" type="button" disabled={pending} onClick={() => void act({ type: 'cancel' })}>Cancel update</button>
      </div>
    </Shell>;
  }

  if (available && state.release) {
    const notes = state.release.metadata.notes.trim();
    return <Shell tone="fresh">
      <Hero eyebrow={`You have ${state.currentVersion}`} title={`${target} is here`} version={target} />
      {notes && <details className="updates-panel__notes" open>
        <summary>What's new</summary>
        <p>{notes}</p>
        <a href={state.release.url} target="_blank" rel="noreferrer">Full release notes</a>
      </details>}
      {receipt?.installation === 'failed' && receipt.problem && <p className="updates-panel__alert" role="alert">The last attempt failed: {receipt.problem}</p>}
      {alerts}
      {dashboards(true)}
      <div className="updates-panel__actions">
        {migratable.length > 0
          ? <><button className="button button--primary button--large" type="button" disabled={working || chosen.length === 0} onClick={() => void act({ type: 'prepare', choice: 'update-and-migrate', selected: chosen })}>
              {chosen.length ? `Update and migrate ${plural(chosen.length, 'dashboard')}` : 'Update and migrate'}
            </button>
            <button className="button button--secondary" type="button" disabled={working} onClick={() => void act({ type: 'prepare', choice: 'update-only', selected: [] })}>Update without migrating</button></>
          : <button className="button button--primary button--large" type="button" disabled={working} onClick={() => void act({ type: 'prepare', choice: 'update-and-migrate', selected: [] })}>Update to {target}</button>}
      </div>
      {migratable.length > 0 && chosen.length === 0 && <p className="updates-panel__note">Select the dashboards to migrate, or update now and migrate them later.</p>}
      {footer}
    </Shell>;
  }

  const justInstalled = installedHere && Boolean(state.installedThisLaunch);
  const upToDate = Boolean(state.checkedAt) && !problem;
  return <Shell tone={justInstalled ? 'celebrate' : 'calm'}>
    {justInstalled
      ? <Hero eyebrow="Update installed" title={`Welcome to ${state.currentVersion}`} version={state.currentVersion}
          body={attention.length ? undefined : 'All set — enjoy the new release.'} />
      : <Hero eyebrow={`dash-bored ${state.currentVersion}`} title={upToDate ? "You're up to date" : problem ? 'Something needs attention' : 'Check for updates'}
          body={upToDate ? `Checked ${relativeTime(state.checkedAt!)}.` : undefined} check={upToDate} />}
    {alerts}
    {dashboards(installedHere)}
    <div className="updates-panel__actions">
      {installedHere && migratable.length > 0 && <button className="button button--primary" type="button" disabled={working || draftsOpen || chosen.length === 0} onClick={() => void act({ type: 'migrate', selected: chosen })}>
        {chosen.length ? `Migrate ${plural(chosen.length, 'dashboard')}` : 'Migrate'}
      </button>}
      {!justInstalled && <button className={`button ${upToDate ? 'button--quiet' : 'button--primary'}`} type="button" disabled={working} onClick={() => void act({ type: 'check' })}>{upToDate ? 'Check again' : 'Check for updates'}</button>}
    </div>
    {installedHere && draftsOpen && migratable.length > 0 && <p className="updates-panel__alert" role="alert">Save or cancel the open dashboard draft before migrating.</p>}
    {footer}
  </Shell>;
}

function Shell({ tone, children }: { tone: 'calm' | 'busy' | 'fresh' | 'celebrate'; children: ReactNode }): ReactNode {
  return <section className="settings-card updates-panel" data-tone={tone} aria-label="Updates" aria-busy={tone === 'busy'}>{children}</section>;
}

function Hero({ eyebrow, title, body, version, check }: { eyebrow: string; title: string; body?: string; version?: string; check?: boolean }): ReactNode {
  return <header className="updates-panel__hero">
    {(version || check) && <span className="updates-panel__badge" aria-hidden="true">{check ? '✓' : version}</span>}
    <div role="status">
      <p className="updates-panel__eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {body && <p className="updates-panel__body">{body}</p>}
    </div>
  </header>;
}

function Progress({ label }: { label: string }): ReactNode {
  return <div className="updates-panel__progress" role="progressbar" aria-label={label}><span /></div>;
}

function MigrationList({ dashboards, receipt, selected, disabled, onToggle }: {
  dashboards: DashboardMigration[]; receipt: UpdateReceipt | null; selected: string[]; disabled: boolean;
  onToggle: (path: string, on: boolean) => void;
}): ReactNode {
  return <fieldset className="updates-panel__dashboards">
    <legend>{plural(dashboards.length, 'dashboard')} {dashboards.length === 1 ? 'needs' : 'need'} migrating</legend>
    {dashboards.map(d => {
      const last = receipt?.migrations[d.configPath];
      const failed = last && (last.status === 'failed' || last.status === 'interrupted') ? last : null;
      return <label key={d.configPath} className="updates-panel__dashboard" title={d.configPath}>
        <input type="checkbox" disabled={disabled || d.status === 'unsupported'} checked={selected.includes(d.configPath)} onChange={e => onToggle(d.configPath, e.target.checked)} />
        <span>
          <strong>{projectName(d.configPath)}</strong>
          <span>{d.status === 'unsupported' ? `Can't migrate automatically. ${d.message}` : d.message}</span>
          {failed && <span className="updates-panel__failed">Last attempt {failed.status}{failed.message ? `: ${failed.message}` : '.'}{failed.snapshot ? ` Snapshot: ${failed.snapshot}` : ''}</span>}
        </span>
      </label>;
    })}
  </fieldset>;
}

function UpdateFooter({ state, disabled, onChange }: { state: UpdateState; disabled: boolean; onChange: (settings: UpdateState['settings']) => void }): ReactNode {
  return <footer className="updates-panel__footer">
    <label><input type="checkbox" disabled={disabled} checked={state.settings.automaticChecks} onChange={e => onChange({ ...state.settings, automaticChecks: e.target.checked })} /> Check automatically</label>
    {SELECTABLE_CHANNELS.length > 1 && <select aria-label="Release channel" disabled={disabled} value={state.settings.channel} onChange={e => onChange({ ...state.settings, channel: e.target.value as UpdateState['settings']['channel'] })}>
      {SELECTABLE_CHANNELS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>}
  </footer>;
}

function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? '' : 's'}`; }

function projectName(configPath: string): string {
  const parts = configPath.split('/').filter(Boolean);
  const at = parts.lastIndexOf('.dash-bored');
  return parts[at > 0 ? at - 1 : Math.max(parts.length - 2, 0)] ?? configPath;
}

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds > -45) return 'just now';
  if (seconds > -3600) return relativeTimeFormat.format(Math.round(seconds / 60), 'minute');
  if (seconds > -86400) return relativeTimeFormat.format(Math.round(seconds / 3600), 'hour');
  return relativeTimeFormat.format(Math.round(seconds / 86400), 'day');
}
