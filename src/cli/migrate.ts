import { resolveProjectLocation } from "../core/index";
import { inspectMigration } from "../updates/migrations";
import { BUNDLED_MIGRATIONS } from "../updates/releases";

export const MIGRATE_USAGE = "dash-bored migrate inspect <dashboard>";

/**
 * Reports whether a dashboard needs migration to this tool's contract, with
 * the cumulative recipes the agent applies. Installing releases and
 * authorizing app-driven migrations are user workflows in the app.
 */
export async function runMigrateCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(MIGRATE_USAGE);
    return 0;
  }
  if (args.length !== 2 || args[0] !== "inspect") throw new Error(`Usage: ${MIGRATE_USAGE}`);
  const path = (await resolveProjectLocation(args[1]!)).configPath;
  const result = await inspectMigration(path, BUNDLED_MIGRATIONS);
  console.log(JSON.stringify(result, null, 2));
  return result.status === "unsupported" ? 1 : 0;
}
