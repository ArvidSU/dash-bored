import { describe, expect, test } from "bun:test";
import {
  gitBranchesCommand,
  parseGitBranchesOutput,
} from "../../dash-bored/components/git-branches/git-branches";

describe("git branches component", () => {
  test("parses branch workload and preserves branches without upstreams", () => {
    const snapshot = parseGitBranchesOutput([
      "meta\tmain\tmain\tdirty",
      "branch\tmain\t\tabc123\t2 days ago\t0\t\t",
      "branch\tfeature/payments\torigin/feature-payments\tdef456\t1 hour ago\t3\t2\t1",
    ].join("\n"));

    expect(snapshot).toEqual({
      current: "main",
      base: "main",
      dirty: true,
      branches: [
        {
          name: "main",
          upstream: null,
          commit: "abc123",
          age: "2 days ago",
          work: 0,
          ahead: null,
          behind: null,
        },
        {
          name: "feature/payments",
          upstream: "origin/feature-payments",
          commit: "def456",
          age: "1 hour ago",
          work: 3,
          ahead: 2,
          behind: 1,
        },
      ],
    });
  });

  test("keeps the base branch value as a shell environment lookup", () => {
    const command = gitBranchesCommand();

    expect(command).toContain('base="${DASH_BORED_BASE_BRANCH:-}"');
    expect(command).toContain('git rev-list --count "$name" --not "$base"');
  });
});
