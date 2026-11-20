---
name: release
description: Cut a drawer release end to end - changelog section, commit, tag, push, live redeploy, then the promo refresh so the README, the site and the screenshots cover it. Use when Spyros says release, cut a release, tag a version, ship vX.Y.Z, or /release.
---

# Release

The versioning rule (one semver for the repo, the tag is its only source) is `CONTRIBUTING.md` → Versioning. This skill
is the routine around it. Work in the live checkout, on `main`.

## 1. Preflight, or stop

```sh
git status --porcelain && git pull --ff-only
```

Tracked changes mean stop and say so: the deploy in step 4 would ship them unreviewed. Other threads merge into this
checkout; if one is mid-merge, wait for it.

## 2. Version and changelog

```sh
git log --oneline $(git describe --tags --abbrev=0)..main
```

Nothing user-facing since the last tag: stop, no release. Otherwise pick the bump: **minor** for anything added,
**patch** for fixes only (pre-1.0, so no major). Move `## Unreleased` entries, plus anything those commits shipped
that it lacks, under `## X.Y.Z - YYYY-MM-DD` in `CHANGELOG.md`, grouped Added / Changed / Fixed / Removed / Security,
written for a user, one line per change, no commit hashes. Leave `## Unreleased` empty above it.

A change to `shared/src/api.ts` that an older CLI or runner cannot speak goes under Changed, with what to update.

## 3. Commit, tag, push

```sh
git commit -am "Release X.Y.Z" && git tag -a vX.Y.Z -m "drawer X.Y.Z" && git push origin main vX.Y.Z
```

Push `main` and the one tag by name: never `--all`, `--mirror` or `--tags` (the checkout holds T3's checkpoint refs).
Never move or re-push an existing tag. The tag starts `release.yml` (the GitHub release) and `docker.yml` (the image
on GHCR, amd64 and arm64).

## 4. Redeploy the live server

The build goes through `heavy` on this host, in the foreground:

```sh
DRAWER_VERSION=$(sh scripts/version.sh) heavy --name drawer-image -- docker compose build
DRAWER_VERSION=$(sh scripts/version.sh) docker compose up -d
systemctl --user restart drawer-agent
```

Then the checks in `AGENTS.md` → Deploy and verify: `/api/health` must report the new version and an OpenSCAD, and
`/api/runners` must list the runner. Restart the runner with the server, always: a runner from older code speaks the
old protocol.

## 5. Promo refresh

Run the `promo-refresh` skill now, so the README, the site and the screenshots cover this release the same day. It
decides itself whether there is drift and commits as `Promo: …`.

## 6. Check the runs

`gh run list --limit 5`: Release, Docker image, CI and (if promo touched `site/` or `docs/assets/`) Pages. Report any
failure with its first error line.

## Report

The version, the changelog lines, the deploy, what promo changed, the state of the runs.
