import { useEffect, useState } from "react";
import type { ScreenCaptureCommand, ScreenCaptureStatus } from "../../shared/screen-capture";
import { host } from "../lib/rpc-client";

export function ScreenCaptureSettings() {
  const [status, setStatus] = useState<ScreenCaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void host.screenCapturePermission("status").then((next) => {
        if (active) setStatus(next);
      }).catch(() => { if (active) setError("Could not check Screen Recording permission."); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, []);

  async function run(command: ScreenCaptureCommand) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await host.screenCapturePermission(command);
      setStatus(next);
      if (next.reset) setNotice("Permission reset. Quit and reopen dash-bored, then return here and choose Request access. Allow Screen Recording in System Settings and relaunch if macOS asks.");
      else if (command === "request" && !next.granted) setNotice("Allow dash-bored in System Settings → Privacy & Security → Screen Recording, then quit and reopen the app.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update Screen Recording permission.");
    } finally { setBusy(false); }
  }

  if (status && !status.supported) return null;
  return <section className="settings-card" aria-labelledby="screen-capture-title">
    <div>
      <h2 id="screen-capture-title">Agent screenshots</h2>
      <p>Agents use Screen Recording permission to capture the dash-bored window for visual checks.</p>
      <p role="status">{status ? status.granted ? "Screen Recording is allowed." : "Screen Recording is not allowed for this build." : "Checking Screen Recording permission…"}</p>
      <p>If screenshots stay blocked after an app update, reset the saved permission, relaunch, and request access again.</p>
    </div>
    <div className="settings-palette-controls">
      <button type="button" className="button button--secondary" disabled={busy || !status || status.granted} onClick={() => void run("request")}>Request access</button>
      <button type="button" className="button button--secondary" disabled={busy || !status} onClick={() => void run("open-settings")}>Open Screen Recording settings</button>
      <button type="button" className="button button--quiet" disabled={busy || !status} onClick={() => void run("repair")}>Reset Screen Recording permission</button>
    </div>
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
