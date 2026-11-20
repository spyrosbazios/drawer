/**
 * Dev-only gallery of the generated UI families (shadcn on Animate UI, AI Elements, resizable panels), in
 * this app's theme. Served by the Vite dev server at /dev/gallery/; never part of the build (the build's
 * only input is web/index.html). `?theme=light|dark` picks the theme, `?open=menu|popover` opens an overlay.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Gallery } from "./gallery";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><Gallery open={params.get("open")} /></StrictMode>);
