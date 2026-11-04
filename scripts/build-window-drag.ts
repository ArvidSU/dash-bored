import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Electrobun preBuild hook: generated library is copied into every macOS app. */
export async function buildWindowDrag(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const root = process.cwd();
  const output = resolve(root, ".hutch/native/libWindowDrag.dylib");
  await mkdir(resolve(root, ".hutch/native"), { recursive: true });
  const child = Bun.spawn([
    "xcrun", "clang", "-dynamiclib", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
    "-install_name", "@rpath/libWindowDrag.dylib",
    "-Wno-unused-parameter", "-mmacosx-version-min=14.0", "-framework", "Cocoa",
    resolve(root, "src/native/window-drag.m"), "-o", output,
  ], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Could not build native window dragging.");
  console.log(`Built native window dragging: ${output}`);
  return output;
}

await buildWindowDrag();
