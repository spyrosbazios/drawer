---
name: promo-refresh
description: Keep drawer's promotional content (the root README.md, the public site in site/ and the screenshots in docs/assets/) in step with what the app actually does and looks like. Use after a release, when Spyros says the README, the site or the screenshots are stale, or when /promo-refresh is invoked.
---

# Promo refresh

The promo surface is the root `README.md`, `site/` (copy in `site/src/components/*.tsx`) and the screenshots in
`docs/assets/*.webp`, which both of them show. It goes stale when features ship or get removed, and when the web app
is redesigned. This skill finds that drift and fixes it.

## 1. Find the range, or stop

The last refresh is the newest commit whose subject starts with `Promo:`.

```sh
last=$(git log -1 --format=%H --grep='^Promo:' main)
git log --oneline ${last:+$last..}main -- . ':!site' ':!docs/assets' ':!README.md'
```

If nothing user-facing landed in that range (only refactors, tests, docs, chores), **stop**. Report "no drift" and
commit nothing. Read `CHANGELOG.md` for the same range: it is the plain-language list of what shipped.

## 2. Find the drift

Check each user-visible claim against the code and `docs/SPEC.md`. Don't trust the README or the site, and don't
trust memory either.

- **Missing:** a shipped feature worth a line that neither the README nor the site mentions.
- **Stale:** a claim about something removed or renamed.
- **Wrong numbers or names:** install commands, the image name, variable names, the sites imports support. Check
  these against `docker-compose.yml`, `.env.example` and `importers/src/sites/`.
- **Screenshots:** anything under `web/src/` changed in the range and a shot shows that screen. The screenshots are
  real captures of the web app, so a redesign makes them wrong.

Rank what you find. Promo shows the strongest few features. It is not a changelog: never list every commit.

## 3. Apply

- **Copy** (the README and the site's section components): edit it directly. Keep the voice: short, concrete, no
  hype, no claim the code does not back.
- **Screenshots:** retake them with `site/scripts/shots.ts` against the web app's mock server, as `site/README.md`
  describes (never the live server: `data/` is personal). Then open every image and look at it: the 3D view can come
  out blank, and a screen can be caught mid-animation. Each file stays under 450 KB.
- A shot that needs sample data the mock does not have is a **proposal**: describe it in the report and don't change
  `web/dev/mock/` unasked.
- Colours come from `web/src/core/theme.ts` and icons from lucide. Paths go through Vite's `base`.

## 4. Verify

Through `heavy` on this host, one at a time:

```sh
heavy --name site-tc -- bun run --cwd site typecheck
heavy --name site-lint -- bun run --cwd site lint
SITE_BASE=/drawer/ heavy --name site-build -- bun run --cwd site build
```

Then serve `site/dist` with `bun run --cwd site preview` under a pid file and look at every section you touched, at
desktop width and at 390 px, light and dark.

## 5. Commit and ship

One commit whose subject starts with `Promo:` (this is the marker step 1 reads), for example
`Promo: README and site cover assemblies`. Push `main`. GitHub Pages (`.github/workflows/pages.yml`) republishes the
site on a push that touches `site/` or `docs/assets/`.

## Report

Lead with what changed. Then list the proposals, if any. Then the one next step.
