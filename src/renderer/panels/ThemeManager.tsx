import { useEffect, useState } from 'react';
import { useTheme } from '../lib/theme';
import { parseProjectThemeReference } from '../../shared/themes';
import type { DashboardSettingsItem, ThemePackageOperation } from '../../shared/contracts';
import { host } from '../lib/rpc-client';

export function ThemeManager({ dashboards = [] }: { dashboards?: readonly DashboardSettingsItem[] }) {
  const { catalog } = useTheme();
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [projectConfigPath, setProjectConfigPath] = useState(dashboards[0]?.configPath ?? '');
  const [operation, setOperation] = useState('add');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const project = scope === 'project';
  const targetConfigPath = projectConfigPath || dashboards[0]?.configPath || '';
  const items = catalog.filter((item) => {
    if (!project) return item.reference.startsWith('global:');
    if (item.reference.startsWith('./')) return true;
    return parseProjectThemeReference(item.reference)?.configPath === targetConfigPath;
  });
  useEffect(() => {
    if (dashboards.some((dashboard) => dashboard.configPath === projectConfigPath)) return;
    setProjectConfigPath(dashboards[0]?.configPath ?? '');
  }, [dashboards, projectConfigPath]);
  const needsName = operation === 'update' || operation === 'remove';
  const usesName = operation === 'add' || needsName;
  const usesRef = operation === 'add' || operation === 'update';
  const validName = !usesName || !name.trim() || /^[A-Za-z][A-Za-z0-9_-]*$/.test(name.trim());
  const valid = (!project || Boolean(targetConfigPath)) && validName
    && (!needsName || Boolean(name.trim()))
    && (operation !== 'add' || Boolean(url.trim()) && !url.trim().startsWith('-'))
    && (!usesRef || !ref.trim().startsWith('-'));
  const request: ThemePackageOperation = {
    op: operation as ThemePackageOperation['op'],
    scope,
    ...(project ? { configPath: targetConfigPath } : {}),
    ...(operation === 'add' ? { url: url.trim() } : {}),
    ...(usesName && name.trim() ? { name: name.trim() } : {}),
    ...(usesRef && ref.trim() ? { ref: ref.trim() } : {}),
  };
  const run = async () => {
    setRunning(true);
    setNotice('');
    try {
      const result = await host.manageThemePackage(request);
      setNotice(operation === 'status' ? `${result.message} ${JSON.stringify(result.details)}` : result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };
  return <section className="settings-card theme-manager" aria-labelledby="theme-management-title" style={{ display: 'block', minWidth: 0 }}>
    <h2 id="theme-management-title">Manage theme packages</h2>
    <div style={{ display: 'grid', gap: '0.75rem', marginTop: '0.75rem', minWidth: 0 }}>
      <p>Project packages use Git submodules; personal packages use managed Git clones. Installing does not select a theme.</p>
      <label className="props-field"><span>Installation scope</span><select aria-label="Theme installation scope" value={scope} onChange={(event) => { setScope(event.target.value as typeof scope); setName(''); setNotice(''); }}>
        <option value="global">Personal — all dashboards</option><option value="project" disabled={dashboards.length === 0}>Dashboard package</option>
      </select></label>
      {project && <>
        <label className="props-field"><span>Dashboard</span><select aria-label="Dashboard package target" value={targetConfigPath} onChange={(event) => { setProjectConfigPath(event.target.value); setName(''); setNotice(''); }}>
          {dashboards.map((dashboard) => <option key={dashboard.configPath} value={dashboard.configPath}>{dashboard.dashboardName?.trim() || dashboard.configPath}</option>)}
        </select></label>
        <code style={{ overflowWrap: 'anywhere' }}>{targetConfigPath}</code>
      </>}
      {items.map((item) => <div key={item.reference} style={{ overflowWrap: 'anywhere' }}>
        <strong>{item.name}</strong> <code>{item.reference}</code>
        {item.manifest?.description && <p>{item.manifest.description}</p>}
        {item.git ? <><p>Source: <code>{item.git.url}</code><br />Pin: <code>{item.git.commit}</code></p>
          <button type="button" className="button button--quiet" onClick={() => { setName(item.git!.name); setOperation('update'); setRef(''); setNotice(''); }}>Manage {item.name}</button></> : <p>Local theme — edit its theme.yaml directly.</p>}
        {item.error && <p role="alert">{item.error}</p>}
      </div>)}
      {!items.length && <p>No themes installed in this scope.</p>}
      <label className="props-field"><span>Operation</span><select aria-label="Theme operation" value={operation} onChange={(event) => { setOperation(event.target.value); setNotice(''); }}>
        <option value="add">Add from repository</option><option value="update">Update pin</option><option value="remove">Remove package</option><option value="sync">Sync pinned checkouts</option><option value="status">Check checkout status</option>
      </select></label>
      {operation === 'add' && <label className="props-field"><span>Repository URL</span><input aria-label="Theme repository URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/ocean.git" /></label>}
      {(operation === 'add' || needsName) && <label className="props-field"><span>Theme name{!needsName ? ' (optional)' : ''}</span><input aria-label="Theme package name" value={name} onChange={(event) => setName(event.target.value)} /></label>}
      {!validName && <p role="alert">Use a name starting with a letter, followed by letters, numbers, underscores or hyphens.</p>}
      {(operation === 'add' || operation === 'update') && <label className="props-field"><span>Revision (optional)</span><input aria-label="Theme revision" value={ref} onChange={(event) => setRef(event.target.value)} placeholder="Branch, tag, or commit" /></label>}
      {operation === 'remove' && <p>Removal deletes the managed checkout. Select another theme if this package is in use. Local changes block removal.</p>}
      <button type="button" className="button button--secondary" disabled={!valid || running} onClick={() => void run()}>{running ? 'Working…' : 'Run theme operation'}</button>
      <span role="status">{notice}</span>
    </div>
  </section>;
}
