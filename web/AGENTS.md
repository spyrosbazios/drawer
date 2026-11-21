# drawer web — agent notes

The drawer web app: a PWA (laptop shell from `md`, phone shell below) over the drawer HTTP API in
`shared/src/api.ts`. An agent-only CAD IDE: a person states intent and reviews, the agent models, the
server's gates decide. No model editor, no sketcher: `.scad` is always read-only here. It talks only to
its own origin (`/api/...`); in production the server serves `web/dist`, in dev Vite proxies `/api`. Behaviour of the API: `docs/SPEC.md`.

<!-- reviewed: 2026-11-21 -->

## Where facts live

| Path | Holds | Authority |
|---|---|---|
| `shared/src/api.ts` | every request/response shape | canonical, never edited from here |
| `src/core/theme.ts` | the only raw colour values (light + dark) | canonical |
| `src/lib/route-search.ts` | every URL search param and its validator | canonical |
| `src/lib/local-pref.ts` | per-browser preferences (folded sections, sidebar hidden, panel sizes) | canonical |
| `src/routes/` | route files (`routeTree.gen.ts` is generated) | canonical |
| `src/core/schemas.ts` | zod readers, each `satisfies` its api.ts type | derived |
| `src/components/ui/` | shadcn output, animated by Animate UI | generated, never hand-edited |
| `src/hooks/use-highlighted-code.ts`, `src/lib/highlighter.tsx` | shadcn `code-block`'s Shiki highlighter; only its language list is ours | generated |
| `dev/mock-server.ts`, `dev/mock/` | in-memory stand-in for the server, scripted fake agent; seed in `dev/mock/seed.ts` | dev only, not in the bundle |
| `dev/gallery/` | every generated building block in this theme, agent thread drawn from `SessionItem[]` by the app's own row renderers | dev only, not in the bundle |

## Commands

    MOCK_PORT=3952 bun run dev/mock-server.ts           # default 3951; 3952 while the real dev server holds 3951
    MOCK_LIBRARY=starter bun run dev/mock-server.ts     # the library's printer still the starter example (Settings → "Set up with the agent")
    VITE_API_TARGET=http://127.0.0.1:3952 bun run dev   # 127.0.0.1:5199, proxies /api
    bun run typecheck | lint | test | build

## Ownership

| Layer | Owns | Never |
|---|---|---|
| `services/` | axios instance, typed errors, zod-checked responses | UI, query keys |
| `hooks/` | query keys and options, mutations, realtime (`apply*Event` per family) | HTTP calls of their own |
| `lib/loaders.ts` | prefetch into the query cache | a cache of its own |
| `components/`, `routes/` | screens | `fetch`/axios, colours, emoji |
| `components/{part,review,session,assembly}/` | the feature slots below | reaching into another slot's files |

## UI building blocks

All three families are shadcn registry items on the Radix base (`radix-nova`), in `src/components/ui/`:

- **Primitives** (popover, menubar, accordion, dialog, drawer, …): `bunx --bun shadcn@latest add <name>`, then
  `bunx @animate-ui/cli@latest animate <name>` (or `animate all`). Animate UI swaps the `radix-ui` import for
  `@animate-ui/react/primitives/radix-ui`: same API, Motion inside. Never add a Base UI or React Aria copy of one.
- **Agent thread**: shadcn's AI Elements (message, bubble, message-scroller, trace, code-block, attachment,
  questionnaire, marker, spinner). Patterns: `https://ui.shadcn.com/docs/ai-elements/radix/<name>.md`, written
  for AI SDK parts: `components/session/` maps `SessionItem` onto them, one case per item type in `thread-items.tsx` (the place a new type gets its renderer). Not `elements.ai-sdk.dev` (deprecated).
- **Layout**: `resizable` (react-resizable-panels v4: `orientation`, sizes as `"30%"` strings).
- Markdown stays react-markdown (no Streamdown); fenced code goes to `CodeBlock` via the `pre` override in `session/markdown.tsx`.
- `vaul` is gone: the drawer is Animate UI's.

    bun run dev   # then /dev/gallery/?theme=light|dark&open=menu|popover

## Invariants

- The URL is the state: ONE selection (`part` | `assembly` | `file`, first wins), `mode`, `at`, `compare`,
  `panel`, `session`, `edit`, the phone's `sheet`, and the home filters. Add a param in `route-search.ts` with
  its validator, then a verb in `lib/nav.ts`. A part's own files (`parts/<id>.scad|.part.json`) open as the part.
- Slots: the shell renders `PartView({slug, part, mode, at, compare})`, `AssemblyView({slug})` (centre),
  `SessionPanel({slug, sessionId})`, `ReviewPanel({slug, part})`, `AssemblyPanel({slug})` (right / phone
  sheets). Props come from the URL only; each slot reads the cache itself. Contracts: the comment atop each file.
- Every centre view wears one `ViewerMenubar` (`viewers/viewer-menubar.tsx`: menus described as data, each menu one
  of `MENU_ICONS`, which gives it its icon; a narrow bar shows the icons alone). The shell adds to it through
  `ShellBarContext`: the Project menu (project settings) and, while a side panel is folded, the button that brings it
  back. So a view with nothing of its own (a notice, the kickstart, a binary file) is wrapped in `PlainViewer`, never
  drawn bare, and a control that is not a menu (Read | Edit, Save) goes in the bar's `tools` / `status`, not in a
  toolbar of its own. Every 3D canvas wears the `ViewCube` (`viewers/view-cube.tsx`, CSS 3D synced to the
  camera, no second WebGL context). "Go to view X" is `CameraRig` in `lib/camera-rig.ts`, behind `ViewControl`: the
  cube, the Camera menu and the 0-6 / F keys all call it. The keys answer anywhere while a viewer is mounted, never
  from a field, a menu or a dialog (`lib/camera-keys.ts`). Sliders and legends stay in the canvas; no loose
  toolbars around it.
- Shell (`components/workspace/`): ONE header (logo, project, add, app menu) with nothing about the agent, the side
  panels or the project's settings in it. Each side panel holds its own fold button (`PanelToggle`: the sidebar's
  search row, the right panel's switch row). Laptop: `WorkspaceLayout`, a resizable group sidebar | centre | right panel; the
  right panel is 300-640 px, its only chrome is the Agent | Review switch, and the agent panel draws its own
  header under it. Open the agent panel with `nav.openSession(id, { reveal })`. The agent's state is shown once, as
  the status chip in the agent panel's header (state only), and what it is doing once, as the thread's tail; elsewhere
  only an `ActivityDot` (agent tab, the menubar's button for the folded panel, phone Session tab). The agent choice
  lives in the agent panel header's settings popover.
- Per-viewer state is not URL state: panel sizes, sidebar hidden, which sections are folded (`lib/local-pref.ts`),
  and the sidebar's search text. The `panel` param stays the truth for the right panel, also when it is dragged shut.
  Only a drag on a separator writes either back (`isUserInteraction`), never a layout the window forced.
- Nothing selected: a project with parts or an assembly redirects (replace) to the assembly, else the first part;
  an empty one shows the kickstart (`workspace/kickstart.ts` holds the prompts, `useStartAgent` in `hooks/start-agent.ts`
  is the one place the workspace starts a session). While a session of the project is on it, the kickstart is an
  animation (`workspace/agent-at-work.tsx`, still under reduced motion) instead of its actions, with no words of its own. The assembly report is requested only when the project's tree lists `assembly.json`.
- Review panels (`review/`, `assembly-panel`) are foldable sections (`Folds`/`Fold`) over a pinned footer
  (`PanelFooter`) that holds every action; a closed section says what it holds, a failing one starts open.
- Statuses are drawn by `StatusChip` (report, gate, session, provider) and gates by `GateList`; never colour a status by hand.
- The default agent for a new session is the server's settings; `useAgentOptions()` (`hooks/agents.ts`) gives the
  runnable provider/model pairs, the default, and a pick for the next session only (`lib/agent-choice.ts`).
  Never store a default agent in the browser. `/settings` is one `SettingsSection` per area; Agents is a list of the
  providers (status and on/off switch) beside the pane of the one picked.
- Session items live in the query cache merged by `seq` (`core/sessions.ts`); a `session` event fetches only
  `?since=<cached version>`. Never refetch a whole session on an event.
- The thread folds a run of tool calls and the thoughts between them into one "N steps" group (`groupRows`); a
  thought with no tool call in its run stays its own row. The thread has ONE live row: the newest item when it is
  a running thought or tool call in a working session (`liveRow`) shimmers, and the activity tail gives way to it;
  in a folded group it is shown below the line like a running step. Stop lives in the composer only.
- Picks for the next message live in `lib/pointing.ts`, outside React, per project; the composer clears them. Unsent text
  and attached files live in `session/composer-drafts.ts` (uploads start at once and run on while the panel is away).
- Thumbnails (`Project.thumbnail`) and render PNGs are addressed by their content and immutable: never add a cache-buster.
  `sw/sw.ts` serves them cache-first (bounded). A project without a thumbnail draws the placeholder and requests nothing.
- Colours: tokens only (`bg-card`, `text-dim`, `text-run`, `var(--app-*)`); three.js and CodeMirror read the CSS variables.
- Unsaved note text lives in `core/drafts.ts`, outside React, so switching selections never loses it. A save always
  sends the rev the draft started from; a 409 or a newer server rev raises the "changed elsewhere" banner.
- The PWA icon source is `public/favicon.svg`, a symlink to `assets/icon.svg`. The generator writes PNGs
  next to its source image, so never point it at `assets/` directly.

## Footguns that actually bit

- 2026-11-20: a mutation's answer carries the new session *record*; writing it into the open session's cache moved
  its version past the item just sent, so `?since=` skipped that item and a sent message never showed. `patchSession`
  now patches lists only and delta-fetches the open session.
- 2026-11-20: `MessageScroller` opens at the end only for rows present at mount; ours arrive after the fetch and
  rows off screen are sized by estimate, so `Thread` scrolls to the end again after the first frames. 2026-11-21: it
  follows new rows only with `autoScroll` on its provider (off by default), which lets go once the reader scrolls up.
- 2026-11-20: a resizable panel that is *unmounted* when hidden loses its layout (react-resizable-panels brings it
  back at 0 wide from the saved layout) and remounts the centre viewer. Keep the panels mounted, collapse them with
  `panelRef`, reopen them with `resize` to the remembered px size (`openSizes`: written by a drag only, so a
  collapsed panel keeps its width, also across reloads). 2026-11-21: `onResize` also fires when a narrow window squeezes
  a panel to zero, which read as the viewer hiding the sidebar for good.
- 2026-11-20: a `<form>` inside the new-project `<form>` (the URL import panel) made Enter and Preview submit
  the outer form and reload the page. Panels that live inside a form must not render a form.
- 2026-11-20: oxlint's `react` correctness rules reject `setState` in an effect body and ref reads during
  render. Derive state from keys or the query cache instead of silencing the rule.
- 2026-11-20 (first run against the real server): `Project.cover` is the *effective* cover (the server's automatic
  pick when none was chosen), and a move arrives as `deleted` (old path) plus `moved` (new path). Echoing `cover` back
  in a PATCH pins the automatic pick; refetching a gone path is a 404. Send only changed fields; skip gone paths.
- 2026-11-20: headless Chromium with SwiftShader WebGL under the `heavy` cap starves the whole browser
  (30 s selector timeouts on pages without any 3D). Run flows with `--disable-gpu`; use GL only for 3D shots.
- 2026-11-20: `chrome-headless-shell --screenshot` captures the boot splash: the open `/api/events` stream keeps
  the page "loading". Drive it over CDP (navigate, wait, `Page.captureScreenshot`) instead.
