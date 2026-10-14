import type { ReactNode } from 'react';
import type { PackageUpdatesController } from '../app/use-package-updates';
import { packageVersionLabel, updatablePackages, type PackageUpdateCommand, type PackageUpdateItem, type PackageUpdateState } from '../../shared/package-updates';
import { plural, Progress, relativeTime } from './UpdatesPanel';

/**
 * Pinned component packages and themes whose repository has moved on. Packages
 * that need a decision lead; up-to-date ones stay folded away. Updating is
 * explicit, and a changed component pin passes the normal trust check.
 */
export function PackageUpdatesPanel({ packages, automaticChecks }: { packages: PackageUpdatesController; automaticChecks?: boolean }): ReactNode {
  const { state, error, pending } = packages;
  if (!state) return <section className="settings-card updates-panel package-updates" aria-label="Package updates">
    <p role="status">{error || 'Loading package updates…'}</p>
  </section>;

  const run = (command: PackageUpdateCommand) => void packages.command(command).catch(() => undefined);
  const busy = pending || state.phase !== 'idle';
  const ready = updatablePackages(state);
  const attention = state.packages.filter(item => item.status !== 'current');
  const current = state.packages.filter(item => item.status === 'current');
  const checked = state.checkedAt !== null;
  return <section className="settings-card updates-panel package-updates" aria-label="Package updates"
    data-tone={state.phase !== 'idle' ? 'busy' : ready.length ? 'fresh' : 'calm'} aria-busy={state.phase !== 'idle'}>
    <header className="package-updates__header">
      <div role="status">
        <h2>Components and themes</h2>
        <p className="updates-panel__body">{summary(state)}</p>
      </div>
      <div className="updates-panel__actions">
        {ready.length > 1 && <button className="button button--primary" type="button" disabled={busy}
          onClick={() => run({ type: 'update', ids: ready.map(item => item.id) })}>Update all {ready.length}</button>}
        <button className={`button ${checked ? 'button--quiet' : 'button--secondary'}`} type="button" disabled={busy}
          onClick={() => run({ type: 'check' })}>{checked ? 'Check again' : 'Check packages'}</button>
      </div>
    </header>
    {state.phase !== 'idle' && <Progress label={state.phase === 'checking' ? 'Checking packages' : 'Updating packages'} />}
    {error && <p className="updates-panel__alert" role="alert">{error}</p>}
    {state.problem && !error && <p className="updates-panel__alert" role="alert">{state.problem}</p>}
    {state.message && state.phase === 'idle' && <p className="updates-panel__note" role="status">{state.message}</p>}
    {attention.length > 0 && <ul className="package-updates__list" aria-label="Packages with updates">
      {attention.map(item => <PackageRow key={item.id} item={item} busy={busy} updating={state.updating.includes(item.id)}
        onUpdate={() => run({ type: 'update', ids: [item.id] })} />)}
    </ul>}
    {current.length > 0 && <details className="package-updates__current">
      <summary>{plural(current.length, 'package')} up to date</summary>
      <ul className="package-updates__list" aria-label="Up-to-date packages">
        {current.map(item => <PackageRow key={item.id} item={item} busy={busy} updating={false} onUpdate={() => undefined} />)}
      </ul>
    </details>}
    <footer className="updates-panel__footer">
      <span>{checked ? `Last checked ${relativeTime(state.checkedAt!)}.` : 'Not checked yet.'} {automaticChecks === false
        ? 'Automatic checks are off.' : 'Checks run with the automatic app update checks.'}</span>
      <span>Updates follow each repository’s default branch.</span>
    </footer>
  </section>;
}

function summary(state: PackageUpdateState): string {
  if (state.phase === 'checking') return 'Checking package repositories…';
  if (state.phase === 'updating') return `Updating ${plural(state.updating.length, 'package')}…`;
  if (state.checkedAt === null) return 'See whether pinned component packages and themes have newer versions.';
  if (state.packages.length === 0) return 'No dashboard pins component packages or themes from a repository.';
  const available = state.packages.filter(item => item.status === 'available').length;
  const unknown = state.packages.filter(item => item.status === 'unknown').length;
  if (available) return `${plural(available, 'update')} available.${unknown ? ` ${plural(unknown, 'package')} could not be checked.` : ''}`;
  if (unknown) return `${plural(unknown, 'package')} could not be checked.`;
  return state.packages.length === 1 ? 'The pinned package is up to date.' : `All ${state.packages.length} pinned packages are up to date.`;
}

function PackageRow({ item, busy, updating, onUpdate }: { item: PackageUpdateItem; busy: boolean; updating: boolean; onUpdate: () => void }): ReactNode {
  const owner = item.configPath === null ? 'Personal' : item.dashboardName?.trim() || item.configPath;
  const from = packageVersionLabel(item.current);
  const to = item.latest ? packageVersionLabel(item.latest) : null;
  const available = item.status === 'available';
  return <li className="package-update" data-status={item.status}>
    <span className="package-update__identity">
      <strong>{item.name}</strong>
      <span className="package-update__meta" title={item.url}>{item.kind === 'component' ? 'Component package' : 'Theme'} · {owner}</span>
    </span>
    <span className="package-update__versions">
      <code title={item.current.commit}>{from}</code>
      {available && to && <><span aria-label="to">→</span><code className="package-update__latest" title={item.latest!.commit}>{to}</code></>}
    </span>
    {available && <span className="package-update__actions">
      {item.changesUrl && <a href={item.changesUrl} target="_blank" rel="noreferrer" aria-label={`Changes in ${item.name} from ${from} to ${to}`}>Changes ↗</a>}
      <button className="button button--secondary button--small" type="button" disabled={busy || Boolean(item.blocked)}
        aria-label={`Update ${item.name} in ${owner}`} onClick={onUpdate}>{updating ? 'Updating…' : 'Update'}</button>
    </span>}
    {available && item.blocked && <span className="package-update__note">{item.blocked}</span>}
    {item.error && <span className="package-update__note package-update__note--error">{item.status === 'unknown' ? `Couldn’t check: ${item.error}` : item.error}</span>}
  </li>;
}
