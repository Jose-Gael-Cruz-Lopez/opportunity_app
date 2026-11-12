import { createRoot } from "react-dom/client";
import ConsoleApp from "./ConsoleApp";
import "../index.css";
import "./console.css";

// The console never applies the glass look: no glass gate runs on this entry, so
// html[data-glass] is never set and every surface stays solid (plan 01 section 4).
const root = document.getElementById("root");
if (!root) throw new Error("console index.html is missing #root");
createRoot(root).render(<ConsoleApp />);
