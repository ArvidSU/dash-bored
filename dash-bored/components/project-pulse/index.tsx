import { defineComponent, useEffect, useState } from "@dash-bored/component";
import "./styles.css";

interface Props {
  packageFile: string;
}

interface ProjectInfo {
  name: string;
  version: string;
  scripts: string[];
}

function parseProjectInfo(source: string): ProjectInfo {
  const manifest = JSON.parse(source) as {
    name?: unknown;
    version?: unknown;
    scripts?: unknown;
  };
  const scripts = manifest.scripts && typeof manifest.scripts === "object"
    ? Object.keys(manifest.scripts).sort()
    : [];

  return {
    name: typeof manifest.name === "string" ? manifest.name : "Unnamed project",
    version: typeof manifest.version === "string" ? manifest.version : "No version",
    scripts,
  };
}

export default defineComponent<Props>(({ props, host }) => {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    if (!host.filesystem) return;
    setLoading(true);
    setError(null);
    try {
      setProject(parseProjectInfo(await host.filesystem.readText(props.packageFile)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [host.filesystem, props.packageFile]);

  useEffect(
    () => host.actions.register({
      id: "refresh-project-pulse",
      label: "Refresh project pulse",
      description: "Read package.json again and update the project summary.",
      keywords: ["package", "scripts", "dashboard"],
      run: refresh,
    }),
    [host.actions, props.packageFile],
  );

  if (!host.filesystem) {
    return <p className="pulse__message">Trust this project to read its package manifest.</p>;
  }

  if (loading) return <p className="pulse__message">Reading {props.packageFile}…</p>;
  if (error) return <p className="pulse__message pulse__message--error">{error}</p>;
  if (!project) return null;

  return (
    <div className="pulse">
      <div className="pulse__identity">
        <strong>{project.name}</strong>
        <code>{project.version}</code>
      </div>
      <p>{project.scripts.length} package scripts available.</p>
      <div className="pulse__scripts" aria-label="Available package scripts">
        {project.scripts.map((script) => <code key={script}>{script}</code>)}
      </div>
      <button className="pulse__refresh" type="button" onClick={() => void refresh()}>
        Refresh manifest
      </button>
    </div>
  );
});
