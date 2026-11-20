# drawer skill and CLI: install

Two symlinks per machine (not done by this repo; run them yourself). Needs [Bun](https://bun.sh) on the PATH.

1. The `drawer` command:

   ```sh
   ln -s "$(pwd)/cli/drawer.ts" ~/.local/bin/drawer
   ```

   `cli/drawer.ts` is executable and imports only its own `cli/src/` modules and Bun built-ins, so a plain
   checkout is enough (no `bun install` needed to run it).

2. The Claude Code skill:

   ```sh
   ln -s "$(pwd)/skill/drawer" ~/.claude/skills/drawer
   ```

Run both from the repository root. If `~/.local/bin` or `~/.claude/skills` are managed by another tool on that
machine (for example stow), put the link in that tool's source directory instead.

Then point the CLI at the server once and check it:

```sh
drawer server http://<host>:3050
drawer health
```

`DRAWER_URL` in the environment overrides the saved server; `DRAWER_AUTHOR` sets the author recorded on writes
(default `agent`). Rendered PNGs are cached in `${XDG_CACHE_HOME:-~/.cache}/drawer/renders/` and are safe to delete.
