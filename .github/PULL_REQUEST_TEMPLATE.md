## What changed and why

## Packages touched
<!-- shared, server, render, importers, cli, agent, web, site, skill, docker, docs -->

## Checklist

- [ ] A change to `shared/src/api.ts` updates the server, the CLI, the web app and the web's mock server in this PR (or: no contract change).
- [ ] Nothing lets a client set a part's status, and nothing adds a way to edit geometry in the web app.
- [ ] Tests and checks run for every package touched (list them below).
- [ ] No secrets, `.env` or `data/` in the diff.
- [ ] I have signed the CLA (see CLA.md; the bot asks on a first PR).

## Tests run
<!-- e.g. `bun run --cwd server typecheck && bun run --cwd server test` -->

<!-- PRs are squash-merged, so the PR title becomes the commit message. CI must pass before merge. -->
