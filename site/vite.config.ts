import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { at, identity, palette } from "./plugins.ts";

export default defineConfig({
  // "/" for a host of its own; the GitHub Pages build sets SITE_BASE=/drawer/.
  base: process.env.SITE_BASE ?? "/",
  plugins: [react(), tailwindcss(), palette(), identity()],
  resolve: { alias: { "@": at("./src") } },
  // The palette (../web/src/core), the screenshots (../docs/assets) and the icon (../assets) live outside this root.
  server: { fs: { allow: [at("..")] } },
  build: { outDir: "dist", emptyOutDir: true },
});
