import { useEffect, useState, type ReactNode } from 'react';
import { host } from '../lib/rpc-client';
import { RELEASE_CHANNELS, type UpdateAction, type UpdateState } from '../../shared/updates';

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
  if (!state) return <section className="settings-card"><h2>Updates</h2><p>{error || 'Loading update status…'}</p></section>;
  const receipt = state.receipt;
  const busy = pending || ['downloading', 'migrating', 'verifying', 'updating-guidance'].includes(state.phase);
  const available = state.release && state.release.metadata.version !== state.currentVersion;
  return <section className="settings-card updates-panel" aria-label="Updates">
    <h2>Updates</h2>
    <p>dash-bored {state.currentVersion}</p>
    <label className="props-field"><span>Release channel</span><select aria-label="Release channel" value={state.settings.channel} onChange={e => void act({ type: 'settings', settings: { ...state.settings, channel: e.target.value as 'canary' } })}>
      {RELEASE_CHANNELS.map(c => <option key={c.id} value={c.id} disabled={!c.available}>{c.label}</option>)}
    </select></label>
    <label className="updates-panel__check"><span><input type="checkbox" checked={state.settings.automaticChecks} onChange={e => void act({ type: 'settings', settings: { ...state.settings, automaticChecks: e.target.checked } })} /> Check at startup and every 24 hours</span></label>
    <p>Downloads and installation start only when you choose them.</p>
    <button className="button" type="button" disabled={busy} onClick={() => void act({ type: 'check' })}>Check for updates</button>
    <p role="status">{state.message}</p>
    {state.phase === "problem" && state.message.includes("lock") && <button className="button" type="button" onClick={() => void act({ type: "recover" })}>Recover interrupted update</button>}
    {error && <p role="alert">{error}</p>}
    {state.release && <>
      <h3>{available ? 'Update available' : 'Installed release'}: {state.release.metadata.version}</h3>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.release.metadata.notes}</p>
      <a href={state.release.url} target="_blank" rel="noreferrer">Release notes on GitHub</a>
    </>}
    {state.dashboards.length > 0 && <fieldset><legend>Dashboards to migrate</legend>
      <p>Select each dashboard explicitly. Unsupported schemas require separate recovery.</p>
      {state.dashboards.map(d => <label key={d.configPath} className="updates-panel__dashboard" style={{ overflowWrap: 'anywhere' }}>
        <span><input type="checkbox" disabled={busy || d.status === 'unsupported'} checked={selected.includes(d.configPath)} onChange={e => setSelected(old => e.target.checked ? [...old, d.configPath] : old.filter(p => p !== d.configPath))} /> {d.configPath}</span>
        <span>{d.message}</span>
      </label>)}
    </fieldset>}
    {available && (!receipt || receipt.cancelled || receipt.installation === 'installed' || receipt.installation === 'failed') && <>
      <p>Update and migrate continues automatically for selected dashboards when the new app starts. Update only may leave affected dashboards unavailable until you migrate them.</p>
      <button className="button" type="button" disabled={busy} onClick={() => void act({ type: 'prepare', choice: 'update-and-migrate', selected })}>Update and migrate</button>{' '}
      <button className="button" type="button" disabled={busy} onClick={() => void act({ type: 'prepare', choice: 'update-only', selected: [] })}>Update only</button>{' '}
      <button className="button" type="button" disabled={busy} onClick={() => void act({ type: 'cancel' })}>Later</button>
    </>}
    {receipt && <>
      <p>App installation: {receipt.installation}. {receipt.cancelled ? 'Automatic continuation cancelled.' : ''}</p>
      {receipt.problem && <p>{receipt.problem}</p>}
      {Object.entries(receipt.migrations).map(([path, m]) => <p key={path} style={{ overflowWrap: 'anywhere' }}>{path}: {m.status}. {m.message} {m.snapshot ? `Recovery snapshot: ${m.snapshot}` : ''}</p>)}
      {!receipt.cancelled && ['ready', 'awaiting-install'].includes(receipt.installation) && <>
        <p>Save or cancel all drafts, then finish running terminals and agent work. Open the verified DMG, quit dash-bored, replace the app, and restart it. macOS may require Open Anyway. Running work is not stopped automatically.</p>
        {state.directInstallAvailable && <><p>Restart and install replaces the app and bundled CLI, closes this window, then reopens the target release. Selected migration authorization continues after restart.</p><button className="button" type="button" disabled={busy || draftsOpen} onClick={() => void act({ type: "install" })}>Restart and install</button></>}
        {draftsOpen && <p role="alert">Resolve the open dashboard draft before installation.</p>}
        <button className="button" type="button" disabled={busy || draftsOpen} onClick={() => void act({ type: 'install', method: 'dmg' })}>Open verified installer</button>{' '}
      </>}
      {receipt.installation === 'installed' && <button className="button" type="button" disabled={busy || !selected.length || draftsOpen} onClick={() => void act({ type: 'migrate', selected })}>Migrate dashboard</button>}{' '}
      <button className="button" type="button" disabled={pending} onClick={() => void act({ type: 'cancel' })}>Cancel continuation</button>
    </>}
  </section>;
}
