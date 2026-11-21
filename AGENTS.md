# drawer

<!-- reviewed: 2026-11-20 -->

Self-hosted, agent-only CAD workspace: a person states intent and reviews, an agent models in OpenSCAD,
the server measures every model against its spec and decides when a part is done. Behaviour and routes:
[`docs/SPEC.md`](docs/SPEC.md). Shapes: [`shared/src/api.ts`](shared/src/api.ts). Web app rules:
[`web/AGENTS.md`](web/AGENTS.md). The agent runner: [`agent/README.md`](agent/README.md). The method every
agent follows: [`server/src/guide.md`](server/src/guide.md). The CLI for outside agents:
[`skill/drawer/SKILL.md`](skill/drawer/SKILL.md).

## Invariants

- **Files are the truth.** `data/projects/<slug>/` (parts, specs, assembly, notes) and `data/sessions/`
  hold everything; `data/index.db` and `data/cache/` are derived and can be deleted (`drawer reindex`
  rebuilds the index, reports are re-measured).
- **The server decides the status.** A part's status comes only from the gates run on its rendered
  mesh. No route lets a client set it, and nothing may trust a value the model reports about itself.
- **Nobody models by hand.** No model editor, no sketcher. A person changes intent only: the brief, a
  spec, parameter values, a waiver, a print result. Do not add a way to edit geometry in the web app.
- **One API for every agent.** The runner's tools are thin calls to public routes; the built-in agent
  has no private path, so the `drawer` CLI can do everything it can.
- **The agent gets drawer's tools and nothing else.** No shell, no file system, no web; the runner
  aborts a turn whose tool list holds anything not prefixed `mcp__drawer__`. Its paths can address its
  own project and `_library/` only.
- **Clients never see git.** Each project folder is a git repo that only the server touches. Git runs
  with `GIT_CEILING_DIRECTORIES` so it can never climb into this source repo.
- **Agents keep no project files locally.** Everything goes through the HTTP API (the `drawer` CLI).
  Do not add a pull/push or sync path.
- **`shared/src/api.ts` is the contract.** Server, CLI, web and the web's mock server change together
  in the same commit.
- **The server depends on `render/` and `importers/` only through `shared/src/contracts.ts`.**
- **The library has a fixed layout**, enforced on every write by `server/src/library-layout.ts` (SPEC →
  Store layout). Widen it there, in the SPEC and in the guide together, never by a route of its own.
- **The server never talks to a model provider.** Providers live behind an adapter in `agent/`; the
  server only hands out work and stores what comes back.
- **No sign-in, so the server guards its own door** (`server/src/http/guard.ts`, [`SECURITY.md`](SECURITY.md)):
  no CORS headers, writes only from its own origin, a `Host` that is an IP, `localhost` or in
  `DRAWER_ALLOWED_HOSTS`. A GET never changes a project: a route with a side effect is a POST.
- **The importer connects to public addresses only**, through `importers/src/http.ts` and nothing else. A site
  module never calls `fetch` itself.

## Footguns

- **`Project.cover` is the effective cover**, not the stored one: the server fills in its automatic
  pick. A client that sends it back on PATCH pins it.
- **A move emits `deleted` (old path) then `moved` (new path)**; either may be a folder.
- **PNG views use OpenSCAD preview mode, not `--render`**: a full render draws orthographic views in one
  flat colour. The STL is still a full Manifold render.
- **OpenSCAD needs no X server** (the nightly creates an EGL context). Don't add xvfb to the image.
- **`workbox-window` must stay a direct dependency of `web/`**: the isolated install in the image does
  not hoist it and the build fails without it.
- **Agent tool schemas must not use tuples.** The Agent SDK sends them as JSON Schema draft-07, whose tuple
  form the API rejects with "JSON schema is invalid", failing every turn before the agent speaks. Use
  fixed-length arrays (2026-11-20; a test in `agent/test/tools.test.ts` guards it).
- **Codex always lists three MCP resource readers** (`list_mcp_resources`, `list_mcp_resource_templates`,
  `read_mcp_resource`); no setting removes them (Codex 0.170). They reach only drawer's MCP server, and the
  runner fails a turn that uses one. Every other Codex built-in is removed: [`agent/README.md`](agent/README.md).
- **Codex runs with its own `CODEX_HOME`** under the runner's state dir and needs its own `codex login`
  there: sharing `~/.codex/auth.json` would race the person's own Codex on token refresh.
- **Docker creates a missing bind-mount folder as root**, and the server (user 1000, or `DRAWER_UID`) then cannot
  write to `/data` and stops at start. That is why `data/.gitkeep` is tracked; never ignore the folder itself again.
  The same day: OpenSCAD does not start when it cannot write `$HOME/.config`, so the image's `HOME` is `/tmp`, which
  any user id can write (2026-11-21, found by running the published 0.1.0 as a new user would).
- **A stale `drawer-render-base` image makes dev lie.** `docker/openscad-dev` runs whatever that image
  holds; without BOSL2 in it an agent "learned" that BOSL2 is not installed and wrote that into the
  library notes (2026-11-20). Rebuild it after touching the Dockerfile's render-base stage.
- **The dev server on 3951 keeps the runner's sessions.** A runner started from older code against it
  claims turns with the old protocol; restart both together.

## Libraries in the image

MCAD (bundled with OpenSCAD) and BOSL2 (pinned commit in `docker/Dockerfile`) are on OpenSCAD's built-in
library path. A library every project should have goes there; a one-off goes in `_library/lib/`.

## Develop

    bun install
    DRAWER_DATA=/tmp/drawer-dev PORT=3951 DRAWER_HOST=127.0.0.1 \
      DRAWER_OPENSCAD=$PWD/docker/openscad-dev bun server/src/main.ts
    VITE_API_TARGET=http://127.0.0.1:3951 bun run --cwd web dev

`docker/openscad-dev` runs OpenSCAD from the `drawer-render-base` image (build it with the
`render-base` target of `docker/Dockerfile`, tagged `drawer-render-base`).
Each package has `typecheck` and `test` scripts; `web` also has `lint` and `build`. Render tests need
`DRAWER_OPENSCAD` set, or the real-OpenSCAD ones are skipped.

A runner for the dev server (real model usage on every message):

    DRAWER_URL=http://127.0.0.1:3951 DRAWER_AGENT_ID=dev bun agent/src/main.ts

## Deploy and verify

A deployment builds from its checkout: `COMPOSE_FILE` in `.env` lists `docker-compose.yml`,
`docker-compose.build.yml` and the local `docker-compose.override.yml`. `docker-compose.yml` alone pulls the
published image.

    DRAWER_VERSION=$(sh scripts/version.sh) docker compose up -d --build
    curl -s http://<host>:3050/api/health              # the version, and openscad must not be null
    systemctl --user restart drawer-agent              # the runner runs the repo's source: restart it after a pull
    curl -s http://<host>:3050/api/runners             # the runner must be listed
    drawer report <project>/<part>                     # a real evaluation end to end

`<host>` is the address the port is published on (`DRAWER_BIND` in `.env`, loopback by default).
The runner is not in the image: it is the user unit `drawer-agent` on the host
([`agent/README.md`](agent/README.md)), because it uses the providers' CLI logins that live there.

Deployment settings, and the optional import credentials, are in `.env` beside `docker-compose.yml` (never committed):
[`.env.example`](.env.example) lists them.

## Release

The git tag is the repository's one version; nothing stores it in a `package.json` (`scripts/version.sh`).
The routine is the `release` skill (`.claude/skills/release/SKILL.md`); the rule is
[`CONTRIBUTING.md`](CONTRIBUTING.md#versioning). A tag starts `release.yml` (the GitHub release, notes from
`CHANGELOG.md`) and `docker.yml` (the image on GHCR, amd64 and arm64). `pages.yml` publishes `site/` on a push to
`main`. The promo surface (the root README, `site/`, the screenshots in `docs/assets/`) is kept in step by the
`promo-refresh` skill.
