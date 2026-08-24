import packageManifest from "../../package.json" with { type: "json" };

/** package.json is the single source of truth for the shipped application version. */
export const APP_VERSION = packageManifest.version;
export const APP_NAME = packageManifest.name;
export const APP_IDENTIFIER = "dev.dash-bored.app";
