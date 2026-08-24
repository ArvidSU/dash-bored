import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: electrobunViteAliases(resolve(import.meta.dirname, ".hutch/devkit")),
  },
  root: "src/renderer",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DASH_BORED_VITE_PORT ?? 5173),
    strictPort: true,
  },
});
