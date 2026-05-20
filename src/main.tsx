import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppStateProvider } from "./state";
import { FLAG_GROUPS } from "./data";
import "./styles.css";

const initialFlags: Record<string, string | number | boolean> = {};
for (const g of FLAG_GROUPS) {
  for (const f of g.flags) {
    initialFlags[f.key] = f.value;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppStateProvider initialFlags={initialFlags}>
      <App />
    </AppStateProvider>
  </React.StrictMode>,
);
