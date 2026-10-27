import { createRoot } from "react-dom/client";
import App from "./App";
import { initFpsMeter } from "./lib/fpsMeter";
import { initAnalytics } from "./lib/analytics";

initFpsMeter();
initAnalytics();
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
