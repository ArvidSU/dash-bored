import { defineComponent, useEffect, useState } from "@dash-bored/component";
import { gitBranchesCommand, parseGitBranchesOutput } from "./git-branches";
import type { GitBranchesSnapshot } from "./git-branches";
import "./styles.css";

interface Props {
  cwd?: string;
  baseBranch?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workLabel(value: number | null): string {
  if (value === null) return "Not available";
  return `${value === 1 ? "commit" : "commits"} on base`;
}

export default defineComponent<Props>(({ props, host }) => {
  const [snapshot, setSnapshot] = useState<GitBranchesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    if (!host.shell) return;
    setLoading(true);
    setError(null);
    try {
      const result = await host.shell.run({
        command: gitBranchesCommand(),
        cwd: props.cwd ?? ".",
        env: props.baseBranch ? { DASH_BORED_BASE_BRANCH: props.baseBranch } : undefined,
        timeoutMs: 10_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Git could not inspect this project.");
      }
      setSnapshot(parseGitBranchesOutput(result.stdout));
    } catch (cause) {
      setSnapshot(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [host.shell, props.cwd, props.baseBranch]);

  useEffect(
    () => host.actions.register({
      id: "refresh-git-branches",
      label: "Refresh Git branches",
      description: "Re-scan local Git branches and their commit workload.",
      keywords: ["git", "branches", "commits", "work"],
      run: refresh,
    }),
    [host.actions, props.cwd, props.baseBranch],
  );

  if (!host.shell) {
    return <p className="git-branches__message">Trust this project to inspect its Git branches.</p>;
  }

  return (
    <section className="git-branches" aria-label="Git branches">
      <header className="git-branches__header">
        <div>
          <strong>Branch workload</strong>
          <span className={`git-branches__tree-state${snapshot?.dirty ? " git-branches__tree-state--dirty" : ""}`}>
            {snapshot ? (snapshot.dirty ? "Uncommitted changes" : "Working tree clean") : "Git status"}
          </span>
        </div>
        <button className="git-branches__refresh" type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </header>

      {error ? <p className="git-branches__message git-branches__message--error" role="alert">{error}</p> : null}
      {loading && !snapshot ? <p className="git-branches__message">Reading local branches…</p> : null}

      {snapshot ? (
        <>
          <div className="git-branches__summary">
            <div>
              <span>Current</span>
              <strong>{snapshot.current}</strong>
            </div>
            <div>
              <span>Work base</span>
              <code>{snapshot.base ?? "Not detected"}</code>
            </div>
            <div>
              <span>Branches</span>
              <strong>{snapshot.branches.length}</strong>
            </div>
          </div>

          {snapshot.branches.length ? (
            <div className="git-branches__list" role="list" aria-label="Local Git branches">
              {snapshot.branches.map((branch) => {
                const isCurrent = branch.name === snapshot.current;
                return (
                  <article className={`git-branch${isCurrent ? " git-branch--current" : ""}`} key={branch.name} role="listitem">
                    <div className="git-branch__identity">
                      <div className="git-branch__name">
                        <span className="git-branch__dot" aria-hidden="true" />
                        <strong>{branch.name}</strong>
                        {isCurrent ? <span className="git-branch__badge">current</span> : null}
                      </div>
                      <span className="git-branch__meta">
                        {branch.commit} · {branch.age}
                        {branch.upstream ? ` · tracks ${branch.upstream}` : " · no upstream"}
                      </span>
                    </div>
                    <div className="git-branch__work">
                      <strong>{branch.work === null ? "—" : branch.work}</strong>
                      <span>{workLabel(branch.work)}</span>
                    </div>
                    <div className="git-branch__tracking" aria-label="Upstream tracking">
                      {branch.ahead !== null ? <span className="git-branch__ahead">↑ {branch.ahead} ahead</span> : null}
                      {branch.behind !== null ? <span className="git-branch__behind">↓ {branch.behind} behind</span> : null}
                      {branch.ahead === null && branch.behind === null ? <span>No upstream comparison</span> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="git-branches__message">No local branches found.</p>
          )}
        </>
      ) : null}
    </section>
  );
});
