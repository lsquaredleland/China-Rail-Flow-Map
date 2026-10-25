import { createRoot } from "react-dom/client";
import App from "./App";
import { initFpsMeter } from "./lib/fpsMeter";

initFpsMeter();
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
