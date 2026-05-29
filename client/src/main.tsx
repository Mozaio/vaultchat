import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initTheme } from "./lib/themeStore";
import { initAccent } from "./lib/accentStore";
import { registerServiceWorker } from "./lib/serviceWorker";
import { initInstallPrompt } from "./lib/installPrompt";
import { ensureDesktopNotifyPermission } from "./lib/desktopNotify";

initTheme();
initAccent();
registerServiceWorker();
initInstallPrompt();
// Desktop app: request OS notification permission up front (no-op in browser).
void ensureDesktopNotifyPermission();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
