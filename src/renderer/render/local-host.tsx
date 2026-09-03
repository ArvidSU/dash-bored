import type { LocalComponentHost, ProcessSnapshot, ResolvedComponentNode } from "../../shared/contracts";
import type { ActionRegistry } from "../lib/actions";
import { ComponentWebviewSurface } from "./ComponentWebviewSurface";
import { host } from "../lib/rpc-client";

export function createLocalHost(
  node: ResolvedComponentNode,
  actionRegistry: ActionRegistry,
  actionScope: string,
  trusted: boolean,
  processesRef: Readonly<{ current: ReadonlyMap<string, ProcessSnapshot> }>,
  onUpdateProps: (props: Record<string, unknown>) => Promise<void>,
): LocalComponentHost {
  const permissions = new Set(node.manifest?.permissions ?? []);
  const actionOwner = {
    scope: actionScope,
    nodeId: node.id,
    componentName: node.manifest?.name ?? node.component,
  };
  const componentHost: LocalComponentHost = {
    dashboard: {
      async reload(): Promise<void> {
        await host.reloadProject();
      },
      updateProps(props): Promise<void> {
        return onUpdateProps(props);
      },
    },
    actions: {
      register(action) {
        return actionRegistry.register(actionOwner, action);
      },
    },
  };

  if (permissions.has("filesystem:read") || permissions.has("filesystem:write")) {
    componentHost.filesystem = {
      readText(path) {
        return host.readTextFile({ nodeId: node.id, path });
      },
      ...(permissions.has("filesystem:write")
        ? {
            writeText(path, content) {
              return host.writeTextFile({ nodeId: node.id, path, content });
            },
          }
        : {}),
    };
  }

  if (permissions.has("network:http")) {
    componentHost.http = {
      request(request) {
        return host.httpRequest({ ...request, nodeId: node.id });
      },
    };
  }

  if (permissions.has("process:execute")) {
    componentHost.shell = {
      run(request) {
        return host.runShell({ ...request, nodeId: node.id });
      },
    };
  }

  if (permissions.has("process:execute") || permissions.has("process:observe")) {
    componentHost.processes = {
      get(nodeId = node.id) {
        return processesRef.current.get(nodeId);
      },
      ...(permissions.has("process:execute")
        ? {
            start() {
              return host.startProcess(node.id);
            },
            open() {
              return host.openProcessTerminal(node.id);
            },
            runQuickAction() {
              return host.runProcessQuickAction(node.id);
            },
            write(input) {
              return host.writeProcessTerminal(node.id, input);
            },
            resize(cols, rows) {
              return host.resizeProcessTerminal(node.id, cols, rows);
            },
            stop() {
              return host.stopProcess(node.id);
            },
          }
        : {}),
    };
  }

  if (trusted && permissions.has("webview:embed")) {
    componentHost.webview = {
      render(request) {
        return <ComponentWebviewSurface url={request.url} title={request.title} />;
      },
    };
  }

  return componentHost;
}
