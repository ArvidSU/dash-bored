import type { DashboardConfig } from "../shared/contracts";
import { COMPONENT_API_VERSION } from "../shared/component-api";
import { DEFAULT_COMPONENT_PACKAGE_NAME } from "../shared/default-component-package";

/*
 * Written by init when the default component package cannot be restored, so a
 * new project still opens without a network connection. It is an ordinary
 * project-local component; nothing in the app recognizes it except init, which
 * may replace an unchanged placeholder once the package is reachable.
 */
export const OFFLINE_STARTER_DIRECTORY = "offline-start";
export const OFFLINE_STARTER_NODE_ID = "offline-start";
const OFFLINE_STARTER_REFERENCE = `./components/${OFFLINE_STARTER_DIRECTORY}`;

export function offlineStarterConfig(projectName: string, reason: string): DashboardConfig {
  return {
    schemaVersion: 4,
    name: projectName,
    root: {
      id: OFFLINE_STARTER_NODE_ID,
      component: OFFLINE_STARTER_REFERENCE,
      props: { reason },
    },
  } as DashboardConfig;
}

/** Only an untouched placeholder may be replaced by a later init. */
export function isOfflineStarterConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const root = (config as { root?: { id?: unknown; component?: unknown; children?: unknown } }).root;
  return root?.id === OFFLINE_STARTER_NODE_ID && root.component === OFFLINE_STARTER_REFERENCE && root.children === undefined;
}

export const OFFLINE_STARTER_FILES: Readonly<Record<string, string>> = {
  "component.yaml": `schemaVersion: 3
apiVersion: ${COMPONENT_API_VERSION}
id: ${OFFLINE_STARTER_DIRECTORY}
name: Offline start
description: Explains that the default dashboard could not be created and how to continue.
entry: ./index.tsx
propsSchema:
  type: object
  additionalProperties: false
  properties:
    reason:
      type: string
permissions: []
`,
  "index.tsx": `import { defineComponent } from "@dash-bored/component";
import "./offline-start.css";

export default defineComponent<{ reason?: string }>(function OfflineStart({ props }) {
  return (
    <section className="offline-start">
      <h2>The default dashboard couldn’t be created</h2>
      <p>
        dash-bored downloads its standard components from a Git package, and that download failed.
        This placeholder is a small project-local component, so the rest of the app works offline.
      </p>
      {props.reason ? <pre className="offline-start__reason">{props.reason}</pre> : null}
      <h3>Build your own</h3>
      <p>
        Components are folders in <code>.dash-bored/components/</code>. Start one with{" "}
        <code>dash-bored component init .dash-bored/components/&lt;name&gt;</code> and point this
        dashboard's <code>root</code> at it in <code>.dash-bored/dash-bored.yaml</code>.
      </p>
      <h3>Get the default dashboard</h3>
      <p>
        When you are online, run <code>dash-bored init</code> again. It replaces this placeholder
        with the default dashboard as long as you haven't edited <code>dash-bored.yaml</code>.
        Run <code>dash-bored component restore</code> to download the standard components
        (<code>./components/external/${DEFAULT_COMPONENT_PACKAGE_NAME}/…</code>) without changing the dashboard.
      </p>
    </section>
  );
});
`,
  "offline-start.css": `.offline-start { max-width: 640px; padding: clamp(18px, 4vw, 36px); color: var(--text); line-height: 1.5; }
.offline-start h2 { margin: 0 0 12px; font-size: 20px; font-weight: 550; }
.offline-start h3 { margin: 24px 0 6px; font-size: 13px; font-weight: 600; }
.offline-start p { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.offline-start code { font: 12px var(--font-mono); color: var(--text); }
.offline-start__reason { margin: 12px 0 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--muted); font: 11px var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
`,
};
