import { createRoot } from "react-dom/client";
import App from "./App";
import { applyLook, readStoredLook } from "./design/look";
import { bootRedirect } from "./lib/routes";
import "./index.css";

// Apply the saved look before the first render so Meadow users never see an Ember flash.
applyLook(readStoredLook());

// Old hash links (#/dashboard) and dev servers opened at "/" land on the matching /app path.
const target = bootRedirect(window.location.pathname, window.location.hash);
if (target) window.history.replaceState(null, "", target);

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
createRoot(root).render(<App />);
