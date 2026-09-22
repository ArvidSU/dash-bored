import {
  addComponent,
  removeComponent,
  syncComponents,
  updateComponent,
} from "../core/external-components";
import { addTheme, removeTheme, statusThemes, syncThemes, updateTheme } from "../core/theme-install";
import { CoreError } from "../core/index";
import type {
  ExternalComponentOperation,
  PackageOperationResult,
  ThemePackageOperation,
} from "../shared/contracts";

/**
 * Runs an external-component pin change for one dashboard bundle. The caller
 * reloads afterwards, so a changed pin goes through the normal trust check.
 */
export async function runExternalComponentOperation(
  configPath: string,
  operation: ExternalComponentOperation,
): Promise<PackageOperationResult> {
  switch (operation.op) {
    case "add": {
      const result = await addComponent(configPath, operation.url, {
        ...(operation.name ? { name: operation.name } : {}),
        ...(operation.ref ? { ref: operation.ref } : {}),
      });
      return { message: `Added ${result.name} at ${result.commit.slice(0, 12)}.`, details: result };
    }
    case "update": {
      const result = await updateComponent(configPath, operation.name, operation.ref ? { to: operation.ref } : {});
      return {
        message: result.changed
          ? `Updated ${result.name} to ${result.commit.slice(0, 12)}. Review trust if permissions changed.`
          : `${result.name} is already at ${result.commit.slice(0, 12)}.`,
        details: result,
      };
    }
    case "remove": {
      const result = await removeComponent(configPath, operation.name);
      return { message: `Removed ${result.name}. Dashboard references keep working until you save a new revision.`, details: result };
    }
    case "sync": {
      const synced = await syncComponents(configPath);
      return {
        message: synced.length === 0 ? "No external components are pinned." : `Synced ${synced.length} external component${synced.length === 1 ? "" : "s"}.`,
        details: synced,
      };
    }
  }
}

export async function runThemePackageOperation(operation: ThemePackageOperation): Promise<PackageOperationResult> {
  if (operation.scope === "project" && !operation.configPath) {
    throw new CoreError("THEME_TARGET_REQUIRED", "Choose the dashboard that owns this theme package.");
  }
  const target = operation.scope === "global" ? { global: true } : { project: operation.configPath! };
  const name = () => {
    if (!operation.name) throw new CoreError("THEME_NAME_REQUIRED", `Theme ${operation.op} requires a package name.`);
    return operation.name;
  };
  switch (operation.op) {
    case "add": {
      if (!operation.url) throw new CoreError("THEME_URL_REQUIRED", "Theme add requires a repository URL.");
      const details = await addTheme(target, operation.url, {
        ...(operation.name ? { name: operation.name } : {}),
        ...(operation.ref ? { ref: operation.ref } : {}),
      });
      return { message: "Theme package added. Select it in Appearance to use it.", details };
    }
    case "update":
      return { message: "Theme package pin updated.", details: await updateTheme(target, name(), operation.ref) };
    case "remove":
      return { message: "Theme package removed.", details: await removeTheme(target, name()) };
    case "sync":
      return { message: "Theme checkouts match their pins.", details: await syncThemes(target) };
    case "status":
      return { message: "Theme checkout status loaded.", details: await statusThemes(target) };
  }
}
