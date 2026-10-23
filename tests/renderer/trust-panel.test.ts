import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSnapshot } from "../../src/shared/contracts";
import { TrustPanel } from "../../src/renderer/panels/TrustPanel";

function markup(available: boolean) {
  const snapshot = {
    tree: null,
    trustReview: { available, hasLocalCode: available },
    requestedPermissions: available ? ["process:execute"] : [],
  } as unknown as ProjectSnapshot;
  return renderToStaticMarkup(createElement(TrustPanel, {
    snapshot, pending: false, onTrust: () => undefined,
  }));
}

test("fatal inspection failures disable trust and explain the missing capability review", () => {
  const html = markup(false);
  expect(html).toContain("Requested capabilities could not be inspected");
  expect(html).toContain("Fix the fatal configuration diagnostics");
  expect(html).not.toContain("No privileged capabilities requested");
  expect(html).toContain('disabled=""');
});

test("nonfatal errors enable trust and disclose code and permissions without a render tree", () => {
  const html = markup(true);
  expect(html).toContain("Load local component code");
  expect(html).toContain("Run project commands");
  expect(html).toContain("You can trust this project to fix its diagnostics with your agent");
  expect(html).not.toContain('disabled=""');
});

test("trust review lists each watch with what it runs and how often", () => {
  const configPath = "/p/.dash-bored/dash-bored.yaml";
  const snapshot = {
    configPath,
    trustReview: { available: true, hasLocalCode: false },
    requestedPermissions: ["background:watch", "process:execute"],
    tree: {
      id: "root",
      component: "./components/external/core/group",
      props: {},
      source: "external",
      sourceConfigPath: configPath,
      children: [
        { node: {
          id: "ci",
          component: "./components/external/core/status",
          manifest: { labelProps: ["label"], resources: { observation: { sourceProp: "source", kind: "status" } } },
          props: { label: "CI", source: { shell: "scripts/ci-status.sh", every: 30000 } },
          watch: { on: ["error"], every: 600000, action: { name: "Remediate with agent", run: "agent:prompt" } },
          source: "external",
          sourceConfigPath: configPath,
        } },
        { node: {
          id: "personal::backlog",
          component: "./components/external/core/list",
          props: { title: "Backlog", source: { file: "todo.json" } },
          watch: { on: ["added"] },
          source: "external",
          sourceConfigPath: "/p/.dash-bored/personal/dash-bored.yaml",
        } },
      ],
    },
  } as unknown as ProjectSnapshot;
  const html = renderToStaticMarkup(createElement(TrustPanel, { snapshot, pending: false, onTrust: () => undefined }));
  expect(html).toContain("Watch views in the background");
  expect(html).toContain("<strong>CI</strong> runs scripts/ci-status.sh every 10 min; notifies on error and offers Remediate with agent.");
  expect(html).not.toContain("Backlog");
  expect(html).toContain("Linked dashboards declare 1 more watch;");
});
