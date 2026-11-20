import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { minimal2023Preset } from "@vite-pwa/assets-generator/presets";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { MANIFEST_COLORS, themePlugin } from "./plugins/theme.ts";
import { DEFAULT_THEME, THEMES } from "./src/core/theme.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The proxy to the drawer API. `changeOrigin` makes the Host the target's, so the server sees a request
 * for itself; the server also refuses writes whose Origin is another host (server/src/http/guard.ts), so
 * a request that is same-origin with this dev server gets the target's origin. Anything else keeps its
 * Origin and is refused upstream, as it would be in production.
 */
function apiProxy(target: string): ProxyOptions {
  const targetOrigin = new URL(target).origin;
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req) => {
        const origin = req.headers.origin;
        if (origin === undefined || req.headers.host === undefined) return;
        let originHost: string | null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost === req.headers.host) proxyReq.setHeader("origin", targetOrigin);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here("."), "VITE_");
  // The dev server proxies the API to a real drawer server or to dev/mock-server.ts.
  const apiTarget = env.VITE_API_TARGET ?? "http://localhost:3050";
  const iconBackground = THEMES[DEFAULT_THEME].C.brand;
  return {
    resolve: {
      alias: {
        "@": here("src"),
        "@drawer/shared": here("../shared/src"),
      },
    },
    define: {
      __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
      __APP_VERSION__: JSON.stringify("0.1.0"),
    },
    server: {
      proxy: { "/api": apiProxy(apiTarget) },
    },
    // `vite preview` serves the production build; production itself is served by the drawer server, same origin.
    preview: {
      proxy: { "/api": apiProxy(apiTarget) },
    },
    build: { sourcemap: false },
    plugins: [
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      themePlugin(),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "sw",
        filename: "sw.ts",
        registerType: "prompt",
        injectRegister: false,
        // The theme plugin owns the theme-color meta: it follows the chosen theme.
        pwaAssets: {
          image: "public/favicon.svg",
          preset: {
            ...minimal2023Preset,
            maskable: { ...minimal2023Preset.maskable, padding: 0.08, resizeOptions: { background: iconBackground } },
            apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background: iconBackground } },
          },
          overrideManifestIcons: true,
          injectThemeColor: false,
        },
        manifest: {
          id: "/",
          name: "drawer",
          short_name: "drawer",
          description: "Workspace and memory store for AI agents doing 3D design",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "any",
          background_color: MANIFEST_COLORS.background,
          theme_color: MANIFEST_COLORS.theme,
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,woff2,png,svg,ico}"],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
  };
});
