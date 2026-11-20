// What the site takes from the app: the palette (web/src/core/theme.ts, the repo's one home of raw colours) as CSS
// variables, and the app icon (assets/icon.svg) as the favicon. The hero screenshot is also emitted under a fixed name
// for the Open Graph card, which needs an address that does not change with each build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { THEMES, themeToCss } from "../web/src/core/theme.ts";

export const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Light on :root; dark when the system asks for it and the visitor has not picked light, or when they picked dark. */
export function palette(): Plugin {
  const ID = "virtual:drawer-palette.css";
  const RESOLVED = `\0${ID}`;
  const css = [
    themeToCss(":root", THEMES.light),
    `@media (prefers-color-scheme: dark){${themeToCss(':root:not([data-theme="light"])', THEMES.dark)}}`,
    themeToCss(':root[data-theme="dark"]', THEMES.dark),
  ].join("\n");
  return {
    name: "drawer-site-palette",
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load: (id) => (id === RESOLVED ? css : undefined),
  };
}

const FILES: Record<string, { path: string; type: string }> = {
  "icon.svg": { path: at("../assets/icon.svg"), type: "image/svg+xml" },
  "social.webp": { path: at("../docs/assets/part.webp"), type: "image/webp" },
};

/** The favicon and the social image, served from memory in dev and emitted at build; the theme-color follows the palette. */
export function identity(): Plugin {
  let base = "/";
  return {
    name: "drawer-site-identity",
    configResolved: (c) => {
      base = c.base;
    },
    configureServer: (s) => {
      s.middlewares.use((req, res, next) => {
        const f = FILES[(req.url ?? "").slice(base.length)];
        if (!f) return next();
        res.setHeader("content-type", f.type);
        res.end(readFileSync(f.path));
      });
    },
    generateBundle() {
      for (const [fileName, f] of Object.entries(FILES)) this.emitFile({ type: "asset", fileName, source: readFileSync(f.path) });
    },
    transformIndexHtml: () => [
      { tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: `${base}icon.svg` }, injectTo: "head" },
      { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: light)", content: THEMES.light.C.bg }, injectTo: "head" },
      { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: dark)", content: THEMES.dark.C.bg }, injectTo: "head" },
    ],
  };
}
