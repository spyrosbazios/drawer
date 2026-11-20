import type { Plugin } from "vite";
import { DEFAULT_THEME, THEME_STORAGE_KEY, THEMES, allThemesCss } from "../src/core/theme.ts";

/**
 * Generates everything that carries a colour from src/core/theme.ts: the CSS variables, the boot
 * script that picks the theme before any bundle loads, and the launch layer. Injected inline into
 * index.html so the first paint already has the right ground (no flash, in dev and in the build).
 */
export function themePlugin(): Plugin {
  return {
    name: "drawer-theme",
    transformIndexHtml() {
      const grounds = { light: THEMES.light.C.bg, dark: THEMES.dark.C.bg };
      const boot = `(function(){try{var c=null;try{c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}
var t=c==="light"||c==="dark"?c:(matchMedia("(prefers-color-scheme: light)").matches?"light":${JSON.stringify(DEFAULT_THEME)});
var g=${JSON.stringify(grounds)};document.documentElement.classList.toggle("dark",t==="dark");
var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",g[t]);}catch(e){}})();`;
      return [
        { tag: "meta", attrs: { name: "theme-color", content: THEMES[DEFAULT_THEME].C.bg }, injectTo: "head-prepend" },
        { tag: "style", children: `${allThemesCss()}#boot{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:var(--app-bg);transition:opacity .3s}#boot.done{opacity:0;pointer-events:none}`, injectTo: "head" },
        { tag: "script", children: boot, injectTo: "head" },
      ];
    },
  };
}

export const MANIFEST_COLORS = { background: THEMES[DEFAULT_THEME].C.bg, theme: THEMES[DEFAULT_THEME].C.bg };
