# drawer site

<!-- reviewed: 2026-11-21 -->

The public page for drawer: Vite, React 19, TypeScript, Tailwind 4, lucide icons, `motion` (the hero background and `useReducedMotion`),
Geist fonts bundled (no request leaves the page). Its palette is the web app's (`../web/src/core/theme.ts`, read by `plugins.ts`), its favicon is
`../assets/icon.svg`, and its screenshots are `../docs/assets/*.webp`, so build with the repo checked out whole.

    bun run dev          # work on it
    bun run build        # tsc -b && vite build, static files in dist/    bun run preview      # serve dist/
    bun run typecheck | lint

- **`SITE_BASE`** is Vite's `base`. GitHub Pages serves the page at `https://spyrosbazios.github.io/drawer/`, so that
  build runs `SITE_BASE=/drawer/ bun run build`; unset, it is `/`. A path the page names goes through the base
  (`import.meta.env.BASE_URL`, `%BASE_URL%`), never a bare `/...`. The Open Graph tags in `index.html` name the Pages
  address in full, because a card needs an absolute URL; `social.webp` there is `docs/assets/part.webp`, emitted by
  `plugins.ts` under a fixed name.
- The repository address (`REPO`) lives in `src/lib.ts`.
- Theme: follows the system until the visitor toggles it; the pick is `data-theme` on `<html>` plus localStorage
  (`src/theme.ts`, restored by the inline script in `index.html`).

## Page

Sections in order: hero, how it works (`Idea`), features (`Features`, a grid of tiles), tour (`Showcase`, screens as tabs
and the phone), agents (`Agents`), a short closing line (`Closing`). The only repository links are the nav's and the
footer's. Its pattern is the TEF Notes promo page's (`~/projects/tefteri/site`): scroll reveal, a hero that stands up as it
scrolls in, cards that light under the pointer, small animated pieces drawn in JSX (`components/mocks.tsx`) next to real
screenshots (`components/ui.tsx` `Crop` cuts a region out of one).

- **Motion stops with `prefers-reduced-motion`.** CSS animations are cut in `index.css`; the JS ones (`useLoop` in
  `mocks.tsx`, the tour's auto-advance, the topography) read `useReducedMotion` and show their last frame, still.
- **The hero background is Animate UI's Topography Background**, copied to `components/topography.tsx` (its two
  `@animate-ui/react` helpers replaced by `motion`'s `useReducedMotion` and a local page-visibility hook). It draws in the
  container's text colour, so the hero sets `text-fg` and a low opacity per theme, and remounts it (a `key`) when the
  theme changes so it redraws. It takes the pointer for its hill and ripples: the hero's content is
  `pointer-events-none` except where it needs them.
- Only `light` captures exist for `home`, `review`, `assembly` and `phone`, so those stay light on a dark page.

## Screenshots

`scripts/shots.ts` drives headless Chromium over the DevTools protocol (Bun's WebSocket, no dependency) against a
running web dev server backed by the mock server, and writes WebP files under 450 KB to `docs/assets/`. It starts
nothing itself. From the repo root, on ports that are free (`ss -ltn`):

    cd web
    MOCK_PORT=3952 bun run dev/mock-server.ts > /tmp/drawer-mock.log 2>&1 & echo $! > /tmp/drawer-mock.pid
    VITE_API_TARGET=http://127.0.0.1:3952 ./node_modules/.bin/vite --host 127.0.0.1 --port 5201 --strictPort \
      > /tmp/drawer-vite.log 2>&1 & echo $! > /tmp/drawer-vite.pid
    cd ../site
    bun run shots http://127.0.0.1:5201              # all; or name some: bun run shots http://127.0.0.1:5201 part phone
    kill $(cat /tmp/drawer-vite.pid) $(cat /tmp/drawer-mock.pid)

Restart the mock before a run: its seeded session is the one waiting for an answer that `session` shows, and the
fake agent changes it once anyone answers. The browser is `DRAWER_CHROME`, by default Playwright's Chromium build
`~/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`; any Chromium works. WebGL (SwiftShader) is on only
for the shots that show the 3D viewer, the rest run with `--disable-gpu` (see web/AGENTS.md). Open every image
afterwards and look at it: a 3D view can come out blank.
