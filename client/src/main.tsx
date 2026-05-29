import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { TitleBar } from "./components/TitleBar";
import { initTheme } from "./lib/themeStore";
import { initAccent } from "./lib/accentStore";
import { registerServiceWorker } from "./lib/serviceWorker";
import { initInstallPrompt } from "./lib/installPrompt";
import { ensureDesktopNotifyPermission } from "./lib/desktopNotify";
import { initDesktopChrome } from "./lib/desktopChrome";
import { initScreenSecurity } from "./lib/screenSecurity";

initTheme();
initAccent();
registerServiceWorker();
initInstallPrompt();
// Desktop app: native-app feel (no browser menu/zoom), apply saved screen
// security, request OS notification permission. All no-op in the browser.
initDesktopChrome();
initScreenSecurity();
void ensureDesktopNotifyPermission();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TitleBar />
    <App />
  </StrictMode>
);
