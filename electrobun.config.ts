import type { ElectrobunConfig } from "electrobun";
import { APP_IDENTIFIER, APP_NAME, APP_VERSION } from "./src/shared/app-metadata";

const devInstance = process.env.DASH_BORED_INSTANCE?.trim().replace(/[^a-zA-Z0-9.-]/g, "-");

export default {
  app: {
    name: APP_NAME,
    identifier: devInstance ? `dev.dash-bored.${devInstance}` : APP_IDENTIFIER,
    version: APP_VERSION,
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "dist/tools": "tools",
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      icons: "assets/icon.iconset",
    },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
