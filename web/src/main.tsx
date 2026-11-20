import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Root } from "./root";

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><Root /></StrictMode>);
