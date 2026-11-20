# Contributing

<!-- reviewed: 2026-11-20 -->

Thanks for looking. Read [docs/SPEC.md](docs/SPEC.md) first: it explains the model (parts, specs, gates, sessions) and
every route. The invariants in [AGENTS.md](AGENTS.md) are the rules most changes have to respect. Security reports go
through [SECURITY.md](SECURITY.md), not issues.

## Ideas and planning

Features are planned in the open, as [issues](https://github.com/spyrosbazios/drawer/issues). A feature request
gets `enhancement`; one that will be built gets `planned`; one that won't is closed with `wontfix` and a line on why.
Open or comment on an issue before a large PR. A PR that finishes one says `Closes #N` and adds its line to
`CHANGELOG.md` under `Unreleased`.

## Layout

| Directory | What it is |
|---|---|
| `shared/` | The contract: `src/api.ts` (every request and response) and `src/contracts.ts` (renderer and importers) |
| `server/` | The HTTP API, the file store, the index, the gates and the sessions |
| `render/` | Running OpenSCAD and measuring meshes |
| `importers/` | Printables, Thingiverse, MakerWorld, Cults3D, MyMiniFactory |
| `cli/` | The `drawer` command and the typed client |
| `agent/` | The runner for the built-in agent: provider adapters and the agent's tools |
| `web/` | The web app; on a phone, the installed PWA |
| `skill/` | The skill that teaches an outside agent the CLI |
| `site/` | The public page |
| `docker/` | The image, and OpenSCAD for development |

It is one bun workspace with one lockfile: `bun install` at the root.

## Rules

- **The server decides the status.** A part's status comes only from the gates run on its rendered mesh. No route lets
  a client set it, and nothing may trust a value the model reports about itself.
- **Nobody models by hand.** Do not add a model editor, a sketcher, or any way to edit geometry in the web app.
- **One API for every agent.** The built-in agent's tools are thin calls to public routes; it has no private path.
- **`shared/src/api.ts` is the contract.** The server, the CLI, the web app and the web's mock server change together,
  in the same PR.
- **bun, and one lockfile.** Do not add a second package manager or a second lockfile.
- **`web/src/components/ui/` is shadcn's output.** Add components with `bunx --bun shadcn@latest add <name>`; never
  hand-edit them.
- **No new colours of your own.** Components and the site use the palette in `web/src/core/theme.ts`.
- **No secrets in the tree.** Import tokens live in `.env`, which is gitignored. Never commit `data/`.
- Fix lint and type errors rather than silencing them (`eslint-disable`, `@ts-ignore`).

## Running the checks

    bun install
    bun run --cwd <package> typecheck
    bun run --cwd <package> test
    bun run --cwd web lint && bun run --cwd web build

`<package>` is `server`, `render`, `importers`, `cli`, `agent`, `web` or `site` (`site` has `typecheck`, `lint` and
`build`). The tests that need a real OpenSCAD are skipped unless `DRAWER_OPENSCAD` is set; [AGENTS.md](AGENTS.md)
(Develop) shows how to get one from the image without installing it.

Run the checks of every package you touched, and of everything that imports it if you changed `shared/`.
Format, then lint, type-check, test and build, in that order.

Commit messages: short and descriptive, no required format. Keep unrelated changes in separate commits.
Pull requests are squash-merged once CI (`.github/workflows/ci.yml`) is green; there is no commit linter and no git hook.

## Licence and CLA

The project is under the [GNU AGPL-3.0](LICENSE): free to use, change and self-host; anyone who serves a modified
version over a network must publish their changes. The maintainer may also offer a paid hosted version.

So that contributions can go into both, every contributor signs the [Contributor License Agreement](CLA.md) once:
on your first pull request, a bot asks you to comment the sentence it quotes. You keep the copyright in your work.

## Versioning

The whole repository has one semver version, and the git tag is its only source: nothing stores it in a `package.json`.
`scripts/version.sh` prints it (`DRAWER_VERSION` if set, else the latest tag without its `v`, else `0.0.0`); the image
is built with it, and `GET /api/health` reports it.

To release: move the `## Unreleased` entries of `CHANGELOG.md` under `## X.Y.Z - date`, commit to `main`, then tag
`vX.Y.Z` and push the tag. `.github/workflows/release.yml` makes the GitHub release, whose notes are that changelog
section; `docker.yml` publishes the image.
