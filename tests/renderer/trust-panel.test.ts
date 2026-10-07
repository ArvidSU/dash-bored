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
