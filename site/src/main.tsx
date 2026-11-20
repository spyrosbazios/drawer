import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The palette is a virtual module (plugins.ts): Tailwind's CSS @import cannot see it, so it is imported here.
import "virtual:drawer-palette.css";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
