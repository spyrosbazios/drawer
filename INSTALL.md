# Install drawer with an agent

<!-- reviewed: 2026-11-21 -->

A person can hand this file to a coding agent (Claude Code, Codex, anything with a shell) and say:
**"Install drawer by following INSTALL.md in github.com/spyrosbazios/drawer."** The agent runs every step it can,
stops only where it needs the person, and finishes with a check that proves the install works.

The human-readable version is the README's [Get started](README.md#get-started) section; this file follows the same
steps and adds no new ones.

## Rules for the agent

- **Run the steps in order and check each one** before you go on. If a check fails, stop and report the exact output.
- **Never use `sudo` yourself.** If a step needs root (installing Docker, adding the user to the `docker` group),
  print the commands for the person and wait until they say it is done.
- **Never sign in for the person.** Provider logins (`claude auth login`, `codex login`, …) are interactive and are
  theirs: print the command, wait.
- **Never expose the port publicly.** `DRAWER_BIND` stays `127.0.0.1` unless the person names a private address
  (a VPN or tailnet address). Never `0.0.0.0`. Read [SECURITY.md](SECURITY.md) if asked to change it.
- **Never put secrets in chat or in commands.** Import tokens are optional; if the person wants them, tell them to
  edit `.env` themselves.
- **Ask once, up front**, the questions in step 0. Do not ask anything else unless a step fails.

## 0. Ask the person

1. Where should the checkout live? Default: `~/drawer` (the runner's unit assumes it).
2. Will drawer be used only on this machine, or from other devices too? If other devices: which private address
   (for example a tailnet IP), and any host name they will type in the browser.
3. Which agent should do the modelling?
   - **The built-in agent** (the runner, step 4): needs Claude Code, Codex, Pi or Gemini signed in on this machine.
   - **Their own agent** through the CLI and skill (step 5).
   - Both, or neither for now.

## 1. Prerequisites

```sh
docker compose version    # Docker with Compose v2
git --version
```

For steps 4 and 5 also [Bun](https://bun.sh): `bun --version` (install without root:
`curl -fsSL https://bun.sh/install | bash`).

If Docker is missing or `docker ps` says permission denied, stop and hand the person the fix for their OS
(Docker's own install guide, then `sudo usermod -aG docker $USER` and a new login). Do not continue without it.

## 2. Get it and configure it

```sh
git clone https://github.com/spyrosbazios/drawer.git ~/drawer
cd ~/drawer
cp .env.example .env
```

Edit `.env` (every line is documented in it):

- `id -u` / `id -g` not `1000`: set `DRAWER_UID` and `DRAWER_GID` to them, or the server cannot write `./data`
  and stops at start.
- Other devices (from step 0): `DRAWER_BIND=<the private address>`, and any host name in `DRAWER_ALLOWED_HOSTS`.
- Optionally `TZ` to the person's time zone.

Check that the port is free: `ss -ltn | grep ':3050 '` prints nothing. If it is taken, set `DRAWER_PORT`.

## 3. Start the server

```sh
docker compose up -d
curl -s http://<DRAWER_BIND>:<DRAWER_PORT>/api/health
```

**Pass**: the JSON has a `version` and `openscad` is not `null`. If it fails: `docker compose logs --tail 50`.

From here `<url>` means `http://<DRAWER_BIND>:<DRAWER_PORT>`.

## 4. The built-in agent (optional)

Needs at least one provider CLI signed in on this machine. Check, and if none is, print the login command for the
one the person wants and wait (table: [agent/README.md](agent/README.md)).

```sh
cd ~/drawer && bun install
```

Codex needs its own login first: `CODEX_HOME=~/.local/state/drawer-agent/codex-home codex login` (the person runs it).

Then install the runner as a service, by OS. If the checkout is not `~/drawer`, change the working directory in the
copied file.

**Linux** (systemd):

```sh
mkdir -p ~/.config/systemd/user
cp agent/drawer-agent.service ~/.config/systemd/user/
# set Environment=DRAWER_URL=<url> in the copied unit
systemctl --user daemon-reload
systemctl --user enable --now drawer-agent
systemctl --user is-active drawer-agent
```

Logs: `journalctl --user -u drawer-agent -n 50`.

**macOS** (launchd):

```sh
mkdir -p ~/Library/LaunchAgents
sed "s|HOME_DIR|$HOME|g" agent/drawer-agent.plist > ~/Library/LaunchAgents/com.drawer.agent.plist
# set DRAWER_URL to <url> in the copied plist if it is not http://127.0.0.1:3050
plutil -lint ~/Library/LaunchAgents/com.drawer.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.drawer.agent.plist
launchctl print gui/$(id -u)/com.drawer.agent | grep state
```

Logs: `~/Library/Logs/drawer-agent.log`. After a plist edit or a `git pull`:
`launchctl kickstart -k gui/$(id -u)/com.drawer.agent`.

**Windows**: untested. Use WSL2 with systemd enabled and follow the Linux steps inside it; Docker Desktop's WSL
integration gives it the same server.

**Then, on every OS:**

```sh
curl -s <url>/api/runners
```

**Pass**: the runner is listed. If not, read the logs above.

## 5. The CLI and skill for their own agent (optional)

```sh
mkdir -p ~/.local/bin ~/.claude/skills
ln -s ~/drawer/cli/drawer.ts ~/.local/bin/drawer
ln -s ~/drawer/skill/drawer ~/.claude/skills/drawer    # Claude Code; other agents: point them at skill/drawer/SKILL.md
drawer server <url>
drawer health
```

If `~/.local/bin` or `~/.claude/skills` are managed by another tool (stow, a dotfiles repo), put the links in that
tool's source instead and say so. Details: [skill/README.md](skill/README.md).

## 6. Finish

Report to the person, in this order:

1. The address to open in a browser: `<url>`.
2. What passed: health (with the version), runner listed, `drawer health`.
3. Anything skipped and why, and anything they still have to do themselves.
4. Two reminders: **there is no sign-in**, so keep the port private; and `~/drawer/data` holds every project and is
   the only copy, so back it up.

To update later: `cd ~/drawer && git pull && docker compose pull && docker compose up -d`, then
restart the runner if it is installed (Linux: `systemctl --user restart drawer-agent`; macOS: the `kickstart` above).
