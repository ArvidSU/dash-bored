import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installComponentRuntime } from "../render/local-components";
import { initializeHost } from "../lib/rpc-client";
import "../styles.css";

async function mountApp(): Promise<void> {
  await initializeHost();
  installComponentRuntime();

  const container = document.getElementById("root");

  if (!container) {
    throw new Error("The renderer root element is missing.");
  }

  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void mountApp();
