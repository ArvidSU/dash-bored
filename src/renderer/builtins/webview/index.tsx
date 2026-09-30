import { Fragment, useEffect, useState, type ReactNode } from "react";
import "./webview.css";
import type { ComponentRendererProps } from "../types";
import { CapabilityGate, stringProp } from "../shared";

export default function Webview({ props, host: componentHost }: ComponentRendererProps): ReactNode {
  const url = stringProp(props, ["url", "src"]);
  const [generation, setGeneration] = useState(0);
  useEffect(() => componentHost.actions.register({
    id: "reload", label: "Reload embedded page", enabled: Boolean(componentHost.webview),
    disabledReason: "Trust this project to embed its configured page.",
    confirmation: { title: "Reload embedded page?", message: "The page will reopen at its configured URL. Unsaved page state may be lost." },
    run: () => setGeneration((value) => value + 1),
  }), [componentHost.actions, componentHost.webview]);
  if (!componentHost.webview) {
    return (
      <CapabilityGate title="Embedded page">
        Trust this project to load its configured web page.
      </CapabilityGate>
    );
  }
  return <Fragment key={generation}>{componentHost.webview.render({ url })}</Fragment>;
}
