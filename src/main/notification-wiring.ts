import { readFile } from "node:fs/promises";
import { Utils } from "electrobun/main";
import { CoreError } from "../core/diagnostics";
import { atomicJson } from "../core/fs-atomic";
import { findResolvedNode } from "../shared/component-agent";
import {
  boundNotificationText,
  NOTIFICATION_MESSAGE_MAX_CHARS,
  type NotificationCommand,
  type NotificationSettings,
  type NotificationState,
} from "../shared/notifications";
import { setDockBadge } from "./dock-badge";
import { NotificationCenter } from "./notification-center";
import {
  AgentNotifications,
  nodeLabel,
  PackageUpdateNotifications,
  ReleaseNotifications,
  RunNotifications,
  type ActiveDashboard,
} from "./notification-producers";

export interface NotificationsOptions {
  /** Small file that remembers which app release already interrupted. */
  memoryPath: string;
  settings(): NotificationSettings;
  publish(state: NotificationState): void;
  active(): ActiveDashboard;
  dashboardName(configPath: string): string | null;
}

/** The notification center wired to Electrobun's system notifications, the dock, and window focus. */
export function createNotifications(options: NotificationsOptions) {
  let focused = true;
  const center = new NotificationCenter({
    publish: options.publish,
    showNative: (notification) => {
      try {
        Utils.showNotification({ ...notification, silent: false });
      } catch (error) {
        console.error("Could not show a system notification.", error);
      }
    },
    setBadge: setDockBadge,
    isWindowFocused: () => focused,
    settings: options.settings,
  });
  const memory = {
    async notified(): Promise<string | null> {
      try {
        const value = JSON.parse(await readFile(options.memoryPath, "utf8")) as { notifiedRelease?: unknown };
        return typeof value.notifiedRelease === "string" ? value.notifiedRelease : null;
      } catch {
        return null;
      }
    },
    async remember(version: string): Promise<void> {
      await atomicJson(options.memoryPath, { version: 1, notifiedRelease: version });
    },
  };

  return {
    center,
    runs: new RunNotifications(center, options.active),
    agents: new AgentNotifications(center, options.dashboardName),
    packages: new PackageUpdateNotifications(center),
    releases: new ReleaseNotifications(center, memory),
    state: (): NotificationState => center.state(),
    setWindowFocused(value: boolean): void {
      if (focused === value) return;
      focused = value;
      // Returning to the window is when decisions delivered as system notifications come forward.
      center.refresh();
    },
    /** A renderer decision, or `notify:<node>` on the active dashboard. */
    command(command: NotificationCommand): void {
      if (command.type !== "notify") {
        center.command(command);
        return;
      }
      const { configPath, dashboardName, tree } = options.active();
      if (!configPath || !tree) throw new CoreError("PROJECT_NOT_LOADED", "Open a dashboard before notifying about one of its components.");
      if (!findResolvedNode(tree, command.nodeId)) {
        throw new CoreError("NOTIFY_TARGET_UNKNOWN", `No component with id ${command.nodeId} exists in the open dashboard.`);
      }
      const message = boundNotificationText(command.message, NOTIFICATION_MESSAGE_MAX_CHARS);
      if (!message) throw new CoreError("NOTIFY_MESSAGE_INVALID", "notify needs a message.");
      center.raise({
        key: `notify:${configPath}:${command.nodeId}:${command.itemId ?? ""}`,
        kind: "notify",
        level: "interrupt",
        configPath,
        dashboardName,
        title: nodeLabel(tree, command.nodeId),
        message,
        target: { kind: "node", nodeId: command.nodeId, ...(command.itemId ? { itemId: command.itemId } : {}) },
      });
    },
  };
}

export type Notifications = ReturnType<typeof createNotifications>;
