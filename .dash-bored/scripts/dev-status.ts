import { listAppInstances } from "../../src/core/app-instances";
import { devInstance, readDevEnvironment } from "../../scripts/dev-environment";

const environment = await readDevEnvironment(process.cwd());
const identifier = devInstance(environment);
const instance = (await listAppInstances()).find((record) => record.identifier === identifier);
console.log(JSON.stringify({
  state: instance ? "healthy" : "unknown",
  detail: instance ? `${environment.DASH_BORED_INSTANCE} · PID ${instance.pid} · auto trust` : "Stopped · Use Start dev app",
}));
