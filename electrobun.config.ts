import type { ElectrobunConfig } from "electrobun";

const devInstance = process.env.DASH_BORED_INSTANCE?.trim().replace(/[^a-zA-Z0-9.-]/g, "-");

export default {
  app: {
    name: "dash-bored",
    identifier: devInstance ? `dev.dash-bored.${devInstance}` : "dev.dash-bored.app",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
