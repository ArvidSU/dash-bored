import { restoreMissingPackages } from "../src/core/package-restore";
const diagnostics = await restoreMissingPackages(process.argv[2] ?? ".");
if (diagnostics.length) { console.error(diagnostics.map((item) => item.message).join("\n")); process.exit(1); }
