import { constants } from "node:os";

const signalNames = new Map<number, string>(
  Object.entries(constants.signals).map(([name, value]) => [value, name]),
);

/** Bun reports a subprocess's signal as a name or a number; snapshots carry the name. */
export function signalName(signalCode: number | NodeJS.Signals | null | undefined): string | null {
  if (signalCode === null || signalCode === undefined) return null;
  if (typeof signalCode === "string") return signalCode;
  return signalNames.get(signalCode) ?? `signal ${signalCode}`;
}
