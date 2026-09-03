import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installComponentRuntime } from "../render/local-components";
import "../styles.css";

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
