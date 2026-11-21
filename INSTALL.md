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

## Before anything: which OS are you on?

Find out what you are running on, and follow only that branch. Never assume the OS from the person's wording.

- **macOS or Linux** (`uname -sm` prints `Darwin` or `Linux`): continue with step 0. The steps note where the two
  differ. If `uname -r` contains `microsoft`, you are inside WSL2 on Windows: also continue, as Linux.
- **Windows, outside WSL** (PowerShell or cmd: `$env:OS` or `%OS%` is `Windows_NT`, or there is no `uname`): drawer
  does not run natively on Windows. Check the three things below with the Windows commands given, show the person
  which are missing, and print what they must do (each needs an admin PowerShell or a setting, so they do it):
  1. WSL2 with Ubuntu: `wsl -l -v` lists Ubuntu with version 2. Fix: `wsl --install -d Ubuntu`, then a reboot.
  2. systemd in that distro: `wsl -d Ubuntu -- systemctl is-system-running` does not fail. Fix: put
     `[boot]` and `systemd=true` in `/etc/wsl.conf` inside Ubuntu, then `wsl --shutdown`.
  3. Docker Desktop with WSL integration for Ubuntu: `wsl -d Ubuntu -- docker info` works. Fix: install Docker
     Desktop, then Settings, Resources, WSL integration, turn on Ubuntu.

  Then **stop**: tell the person to open the Ubuntu terminal, start their agent there, and paste the same prompt
  again. Everything from step 0 runs inside Ubuntu. Two things to tell them: drawer opens at `http://localhost:3050`
  in their Windows browser, and WSL stops when idle, which stops the runner, so they keep an Ubuntu terminal open
  while they use the built-in agent.

## 0. Ask the person

1. Where should the checkout live? Default: `~/drawer` (the runner's unit assumes it).
2. Will drawer be used only on this machine, or from other devices too? If other devices: which private address
   (for example a tailnet IP), and any host name they will type in the browser.
3. Which agent should do the modelling?
   - **The built-in agent** (the runner, step 4): needs Claude Code, Codex, Pi or Gemini signed in on this machine.
   - **Their own agent** through the CLI and skill (step 5).
   - Both, or neither for now.

## 1. Check the requirements

Run every check before installing anything, then show the person one table: each requirement, found or missing,
and the fix for each missing one. Install only what needs no root (Bun, and on macOS the Docker runtime below); for the rest, print the fix and wait.

| Requirement | Check | Pass | Fix when missing |
|---|---|---|---|
| OS | `uname -sm` | Linux (WSL2 included) or macOS (Darwin), x86_64 or arm64 | see "Before anything" above |
| Docker running | `docker info --format '{{.ServerVersion}}'` | prints a version | not found: Docker Engine (Linux) or Docker Desktop (macOS, Windows). "permission denied": add the user to the `docker` group (root) and log in again. "Cannot connect": start Docker |
| Compose v2 | `docker compose version` | `v2` or newer | the Compose plugin, installed with Docker |
| git, curl | `git --version && curl --version` | both print a version | the OS package manager |
| Memory | Linux `free -g`, macOS `sysctl -n hw.memsize` | 8 GB or more | less: set `DRAWER_MEMORY=2g` in step 2 and tell the person big renders may fail |
| Disk | `df -h ~` | 3 GB free | free space first |
| Bun (steps 4, 5) | `bun --version` | prints a version | `curl -fsSL https://bun.sh/install \| bash`, then a new shell |
| A provider CLI (step 4) | `codex --version`, `pi --version`, `gemini --version` | any one, or none for Claude | Claude needs no CLI install: the runner bundles Claude Code. Sign-in is checked in step 4 |

Do not continue past a missing Docker, Compose or git.

### macOS without Docker

If `docker` is not found on macOS, ask the person once which runtime they want, and recommend Colima:

- **Colima** (recommended): free and open source, no app, lightest. You install it.
- **Docker Desktop**: the official app. They install it from docker.com and start it; you wait, then re-run the checks.
- **Another runtime they already use** (OrbStack, Rancher Desktop): they start it; you re-run the checks.

For Colima, you install everything yourself, without root:

1. Homebrew: `brew --version`. If missing, stop: its installer asks for the person's password, so they run
   `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` and follow
   its last lines to put `brew` on the PATH. Then continue.
2. Install and register the Compose plugin:

   ```sh
   brew install colima docker docker-compose
   mkdir -p ~/.docker/cli-plugins
   ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
   ```

3. Start it with room for a render (drawer allows a container 4 GB; Colima's default VM has 2 GB), and keep it
   running across reboots:

   ```sh
   colima start --cpu 2 --memory 6 --disk 20
   brew services start colima
   ```

   On an 8 GB Mac use `--memory 4` and set `DRAWER_MEMORY=3g` in step 2.
4. Re-run the Docker and Compose checks; `docker context show` prints `colima`.

Tell the person: drawer runs only while Colima runs; `colima stop` frees its memory, `colima start` brings it back.
Source: [colima.run/docs/installation](https://colima.run/docs/installation/).

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

Check that the port is free: `curl -s http://127.0.0.1:3050` must fail to connect (exit code 7). If it is taken, set `DRAWER_PORT`.

## 3. Start the server

```sh
docker compose up -d
curl -s http://<DRAWER_BIND>:<DRAWER_PORT>/api/health
```

**Pass**: the JSON has a `version` and `openscad` is not `null`. If it fails: `docker compose logs --tail 50`.

From here `<url>` means `http://<DRAWER_BIND>:<DRAWER_PORT>`.

### Install the web app

Open `http://localhost:3050` on the server itself, or use HTTPS from another device. A plain HTTP URL on a LAN or
tailnet IP can open drawer in a tab, but Chromium needs HTTPS there to offer app installation.

For example, on a Tailscale host with HTTPS enabled, keep drawer bound to `127.0.0.1` and add the host's full
Tailscale DNS name (without a port) to `DRAWER_ALLOWED_HOSTS` in `.env`. Run `docker compose up -d` to apply the
setting, then run `tailscale serve --bg http://127.0.0.1:3050`. Open the HTTPS URL printed by Serve from a device on
the tailnet. If port 443 already serves another app, choose an unused port with `--https=<port>`.

In Chromium, select **App menu → Install app** when it appears. On iOS, use **Share → Add to Home Screen**.

## 4. The built-in agent (optional)

Needs at least one provider signed in on this machine. Ask which one the person wants; if they know it is not
signed in yet, print its login command now ([agent/README.md](agent/README.md)) and wait. The runner confirms it below.

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

**Pass**: the runner is listed, and in its `providers` the one the person wants is `ready`. The runner checks each
provider itself, so this is the sign-in check: `signed_out` means the person runs that provider's login (table in
[agent/README.md](agent/README.md)), `not_installed` means its CLI is missing. The status refreshes within 5 minutes;
restart the runner to see it at once. If the runner is not listed, read the logs above.

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
