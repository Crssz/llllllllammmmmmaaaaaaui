import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppEffects } from "./state";
import { defaultFlags } from "./data";
import "./styles.css";

const initialFlags = defaultFlags();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppEffects initialFlags={initialFlags} />
    <App />
  </React.StrictMode>,
);
