import { expect, test } from "bun:test";
import {
  isLegacyAppThemeReference,
  upgradeLegacyAppThemeReference,
} from "../../src/migrations/app-theme-reference";
import { projectThemeReference, type ThemeCatalogItem } from "../../src/shared/themes";

const ACTIVE = "/workspace/active/.dash-bored/dash-bored.yaml";
const OTHER = "/workspace/other/.dash-bored/dash-bored.yaml";
const catalog: ThemeCatalogItem[] = [
  { reference: projectThemeReference(OTHER, "./themes/plum"), name: "Plum elsewhere" },
  { reference: projectThemeReference(ACTIVE, "./themes/plum"), name: "Plum" },
  { reference: "global:ocean", name: "Ocean" },
];

test("recognizes only bare bundle-local theme paths as legacy app references", () => {
  expect(isLegacyAppThemeReference("./themes/plum")).toBeTrue();
  expect(isLegacyAppThemeReference("./themes/external/remote")).toBeTrue();
  expect(isLegacyAppThemeReference("global:ocean")).toBeFalse();
  expect(isLegacyAppThemeReference(projectThemeReference(ACTIVE, "./themes/plum"))).toBeFalse();
  expect(isLegacyAppThemeReference(undefined)).toBeFalse();
});

test("pins a legacy app theme to the active dashboard's package", () => {
  expect(upgradeLegacyAppThemeReference("./themes/plum", ACTIVE, catalog))
    .toBe(projectThemeReference(ACTIVE, "./themes/plum"));
  expect(upgradeLegacyAppThemeReference("./themes/missing", ACTIVE, catalog)).toBeUndefined();
  expect(upgradeLegacyAppThemeReference("./themes/plum", null, catalog)).toBeUndefined();
  expect(upgradeLegacyAppThemeReference("global:ocean", ACTIVE, catalog)).toBeUndefined();
});
