import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initTheme } from "./lib/themeStore";
import { initAccent } from "./lib/accentStore";
import { registerServiceWorker } from "./lib/serviceWorker";

initTheme();
initAccent();
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
