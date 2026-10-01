import { describe, expect, test } from "bun:test";
import { INSTALL_APP_JAVASCRIPT } from "../../src/core/project-readme";

const checksum = "a".repeat(64);
const api = "https://api.github.com/repos/ArvidSU/dash-bored/releases?per_page=100&page=";
const base = "https://github.com/ArvidSU/dash-bored/releases/download/";

function release(version: string, draft = false) {
  return { tag_name: `v${version}`, draft, prerelease: true, assets: [
    { name: "dash-bored-release.json" }, { name: `dash-bored-v${version}.dmg` },
  ] };
}

function metadata(version: string, contract = 3) {
  return { format: 1, product: "dash-bored", channel: "canary", platform: "macos", arch: "arm64",
    version, dashboardContract: contract, minimumContract: 2,
    dmg: { file: `dash-bored-v${version}.dmg`, sha256: checksum } };
}

function installer(responses: Record<string, unknown>, digest = checksum) {
  const commands: string[] = [];
  const application = {
    includeStandardAdditions: false,
    doShellScript(command: string) {
      commands.push(command);
      if (command === "uname -s") return "Darwin";
      if (command === "uname -m") return "arm64";
      if (command === "sw_vers -productVersion") return "14.7.1";
      if (command.includes("mktemp")) return "/tmp/dash-bored-install.fixture";
      if (command.includes("shasum")) return `${digest}  installer.dmg`;
      if (command.includes("curl")) {
        const url = /'(https:[^']+)'/.exec(command)?.[1];
        if (!url || !(url in responses)) throw new Error(`Unexpected download: ${command}`);
        return JSON.stringify(responses[url]);
      }
      if (command.startsWith("/usr/bin/open ") || command.startsWith("/bin/rm -rf ")) return "";
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  const run = new Function("Application", `${INSTALL_APP_JAVASCRIPT}\nreturn run;`)({ currentApplication: () => application }) as (args: string[]) => string;
  return { run: () => run(["3"]), commands };
}

describe("bundle installer", () => {
  test("chooses the newest exact schema, excluding drafts and releases requiring migration", () => {
    const fixture = installer({
      [`${api}1`]: [release("0.8.0"), release("0.6.0"), release("0.7.0"), release("0.9.0", true)],
      [`${base}v0.8.0/dash-bored-release.json`]: metadata("0.8.0", 4),
      [`${base}v0.7.0/dash-bored-release.json`]: metadata("0.7.0"),
      [`${base}v0.7.0/dash-bored-v0.7.0.dmg`]: "fixture",
    });
    expect(fixture.run()).toContain("v0.7.0 for schema 3");
    expect(fixture.commands.filter(command => command.startsWith("/usr/bin/open "))).toHaveLength(1);
    expect(fixture.commands.some(command => command.includes("v0.9.0"))).toBeFalse();
  });

  test("searches subsequent GitHub pages and orders prerelease versions correctly", () => {
    const fixture = installer({
      [`${api}1`]: Array.from({ length: 100 }, () => release("2.0.0", true)),
      [`${api}2`]: [release("0.7.0-rc.2"), release("0.7.0-rc.10")],
      [`${base}v0.7.0-rc.10/dash-bored-release.json`]: metadata("0.7.0-rc.10"),
      [`${base}v0.7.0-rc.10/dash-bored-v0.7.0-rc.10.dmg`]: "fixture",
    });
    expect(fixture.run()).toContain("v0.7.0-rc.10");
  });

  test("never opens a download whose checksum differs", () => {
    const fixture = installer({
      [`${api}1`]: [release("0.7.0")],
      [`${base}v0.7.0/dash-bored-release.json`]: metadata("0.7.0"),
      [`${base}v0.7.0/dash-bored-v0.7.0.dmg`]: "fixture",
    }, "b".repeat(64));
    expect(fixture.run).toThrow("SHA-256 mismatch");
    expect(fixture.commands.some(command => command.startsWith("/usr/bin/open "))).toBeFalse();
    expect(fixture.commands.at(-1)).toStartWith("/bin/rm -rf ");
  });

  test("reports no compatible published release without guessing from an app version", () => {
    const fixture = installer({
      [`${api}1`]: [release("0.7.0")],
      [`${base}v0.7.0/dash-bored-release.json`]: metadata("0.7.0", 4),
    });
    expect(fixture.run).toThrow("No published canary release opens dashboard schema 3");
    expect(fixture.commands.some(command => command.includes("mktemp"))).toBeFalse();
  });

  test("rejects unsafe artifact names and mismatched metadata versions", () => {
    for (const invalid of [
      { ...metadata("0.7.0"), dmg: { file: "../../unsafe.dmg", sha256: checksum } },
      metadata("0.6.0"),
    ]) {
      const fixture = installer({ [`${api}1`]: [release("0.7.0")], [`${base}v0.7.0/dash-bored-release.json`]: invalid });
      expect(fixture.run).toThrow("Invalid compatible release metadata");
      expect(fixture.commands.some(command => command.includes("mktemp"))).toBeFalse();
    }
  });
});
