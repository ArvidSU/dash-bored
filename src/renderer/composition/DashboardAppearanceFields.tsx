import type { ReactNode } from "react";
import type { DashboardConfig } from "../../shared/contracts";
import { ThemeSelect } from "../lib/theme";

/** The library's window-appearance fields; changes land in the dashboard draft. */
export function DashboardAppearanceFields({
  config,
  onChange,
}: {
  config: DashboardConfig | null | undefined;
  onChange(change: Pick<DashboardConfig, "theme" | "themeMode">): void;
}): ReactNode {
  return (
    <details className="dashboard-appearance">
      <summary>Dashboard appearance</summary>
      <label className="props-field"><span>Window theme</span><ThemeSelect inherit
        value={config?.theme}
        onChange={(theme) => onChange({ theme })} /></label>
      <label className="props-field"><span>Window appearance</span><select aria-label="Dashboard appearance" value={config?.themeMode ?? ""} onChange={(event) => onChange({ themeMode: (event.target.value || undefined) as DashboardConfig["themeMode"] })}>
        <option value="">Use app default</option><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
      </select></label>
      <p>Applies to the whole window. Save dashboard to keep the selection.</p>
    </details>
  );
}
