import type { ReactNode } from "react";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";

export default function Webview({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const url = stringProp(props, ["url", "src"]);
  if (!componentHost.webview) {
    return (
      <CapabilityGate title="Embedded page">
        Trust this project to load its configured web page.
      </CapabilityGate>
    );
  }
  return componentHost.webview.render({ url });
}
