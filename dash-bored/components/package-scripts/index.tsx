import { defineComponent, useCallback, useEffect, useState } from "@dash-bored/component";
import {
  packageRunner,
  packageScriptActionId,
  packageScriptCommand,
  packageScriptOutput,
  packageWorkingDirectory,
  parsePackageScripts,
} from "./package-scripts";
import type {
  PackageRunner,
  PackageScript,
  PackageScriptsInfo,
} from "./package-scripts";
import "./styles.css";

interface Props {
  packageFile: string;
  runner?: PackageRunner;
}

interface ScriptRunState {
  name: string;
  phase: "running" | "completed" | "failed";
  output: string;
}

interface ScriptRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default defineComponent<Props>(({ props, host }) => {
  const [manifest, setManifest] = useState<PackageScriptsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runState, setRunState] = useState<ScriptRunState | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!host.filesystem) return;
    setLoading(true);
    setError(null);
    try {
      setManifest(parsePackageScripts(await host.filesystem.readText(props.packageFile)));
    } catch (cause) {
      setManifest(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [host.filesystem, props.packageFile]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runner = packageRunner(manifest?.packageManager, props.runner);
  const runScript = useCallback(async (script: PackageScript): Promise<void> => {
    if (!host.shell) return;
    setRunState({ name: script.name, phase: "running", output: "" });
    let result: ScriptRunResult;
    try {
      result = await host.shell.run({
        command: packageScriptCommand(runner, script.name),
        cwd: packageWorkingDirectory(props.packageFile),
        timeoutMs: 30_000,
      });
    } catch (cause) {
      const message = errorMessage(cause);
      setRunState({ name: script.name, phase: "failed", output: message });
      throw cause;
    }
    const output = packageScriptOutput(result.stdout, result.stderr);
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut) {
      const reason = result.timedOut
        ? "The script timed out."
        : result.signal
          ? `The script was terminated by ${result.signal}.`
          : `The script exited with code ${result.exitCode ?? "unknown"}.`;
      setRunState({ name: script.name, phase: "failed", output: output || reason });
      throw new Error(output ? `${reason}\n${output}` : reason);
    }
    setRunState({ name: script.name, phase: "completed", output });
  }, [host.shell, props.packageFile, runner]);

  useEffect(() => {
    if (!manifest) return;
    const disposers = manifest.scripts.map((script, index) => host.actions.register({
      id: packageScriptActionId(index),
      label: `Run ${script.name}`,
      description: `Run the ${script.name} package script from ${props.packageFile}.`,
      keywords: ["package", "script", script.name, runner],
      enabled: Boolean(host.shell),
      ...(host.shell ? {} : { disabledReason: "Trust this project to run package scripts." }),
      run: () => runScript(script),
    }));
    return () => disposers.forEach((dispose) => dispose());
  }, [host.actions, host.shell, manifest, props.packageFile, runScript, runner]);

  if (!host.filesystem) {
    return <p className="package-scripts__message">Trust this project to read and run its package scripts.</p>;
  }

  if (loading) return <p className="package-scripts__message">Reading {props.packageFile}…</p>;
  if (error) return <p className="package-scripts__message package-scripts__message--error" role="alert">{error}</p>;
  if (!manifest) return null;

  return (
    <section className="package-scripts" aria-label="Package scripts">
      <header className="package-scripts__header">
        <div className="package-scripts__identity">
          <strong>{manifest.name ?? "Unnamed package"}</strong>
          {manifest.version ? <code>v{manifest.version}</code> : null}
        </div>
        <button className="package-scripts__refresh" type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      <p className="package-scripts__summary">
        {manifest.scripts.length} {manifest.scripts.length === 1 ? "script" : "scripts"} · {runner} run
      </p>

      {manifest.scripts.length ? (
        <div className="package-scripts__list" role="list" aria-label="Runnable package scripts">
          {manifest.scripts.map((script) => {
            const active = runState?.name === script.name;
            return (
              <article className="package-script" key={script.name} role="listitem">
                <div className="package-script__identity">
                  <code>{script.name}</code>
                  <span>{script.command}</span>
                </div>
                <button
                  className="package-script__run"
                  type="button"
                  disabled={!host.shell || (active && runState.phase === "running")}
                  onClick={() => void runScript(script).catch(() => undefined)}
                >
                  {active && runState.phase === "running" ? "Running…" : "Run"}
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="package-scripts__message">No scripts are declared in this package.</p>
      )}

      {runState && runState.phase !== "running" ? (
        <div className={`package-scripts__result package-scripts__result--${runState.phase}`} aria-live="polite">
          <strong>{runState.phase === "completed" ? `${runState.name} finished` : `${runState.name} failed`}</strong>
          {runState.output ? <pre>{runState.output}</pre> : <span>No output.</span>}
        </div>
      ) : null}
    </section>
  );
});
