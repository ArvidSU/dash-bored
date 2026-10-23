// Compiled inside the candidate source tree; invokes the same refresh used on app launch.
import { updateInstalledTools } from "./src/main/installed-tools";
import { SETUP_PROMPT } from "./.dash-bored/components/external/core/shared/setup-prompt";
if (process.argv[2] === "prompt") {
  console.log(`Use /home/bun/project/.dash-bored/dash-bored.yaml as the exact owning configuration. ${SETUP_PROMPT}`);
} else {
  const diagnostics = await updateInstalledTools({
    cliPath: "/home/bun/app/dash-bored",
    projectRoots: ["/home/bun/existing-project"],
  });
  console.log(JSON.stringify(diagnostics, null, 2));
  if (diagnostics.some((item) => item.severity === "warning" || item.severity === "error")) process.exit(1);
}
