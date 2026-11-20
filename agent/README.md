# drawer agent runner

Long-polls the drawer server for session work and drives a provider's coding agent with drawer's tools
only. Protocol: [`docs/SPEC.md`](../docs/SPEC.md) → Agent sessions and Settings. Tools: `src/tools.ts`.

<!-- reviewed: 2026-11-21 -->

Before every poll the runner reads the server's settings and reports each provider's status (checked
without a model call, cached 5 minutes) with the CLI path it resolved. The runner handles no keys:
each provider uses its own CLI login on this host. Which CLI it runs is this host's decision only
(`DRAWER_AGENT_<KIND>_BIN` below), never the server's: anyone who can reach the server's port can change
its settings, and must not be able to pick what runs here. Model ids and resume handles from the server
are checked again before they reach a CLI's arguments.

## Providers and how each is kept to drawer's tools

The CLI providers get drawer's tools from an MCP server the runner starts per turn on `127.0.0.1`
with a random bearer token (`src/mcp-server.ts`). That server also records every tool call, so a
session's tool items come from drawer, not from what the provider says. Every provider runs in an
empty working directory under `DRAWER_AGENT_STATE/sessions/`, and a turn fails the moment the
provider shows or tries a tool that is not drawer's.

| Provider | Runs | Only drawer's tools because | Sign in |
|---|---|---|---|
| `claude` | Claude Agent SDK, its bundled Claude Code | built-in tools off, drawer's in-process MCP server only, `dontAsk`; aborts if the init tool list holds anything else | `claude auth login` |
| `codex` | `codex app-server`, one per turn, `CODEX_HOME=DRAWER_AGENT_STATE/codex-home` | own home (none of your config, MCP servers, skills, hooks), a model catalog with `tool_mode: "direct"`, no shell and no `apply_patch`, feature switches off, `--strict-config`; any item but messages and drawer MCP calls fails the turn | once, separately: `CODEX_HOME=<state>/codex-home codex login` |
| `pi` | `pi --mode rpc`, one per turn | a throw-away agent dir with only drawer in `mcp.json` and your `auth.json` symlinked (pi locks the resolved file, so token refresh is shared safely), `--tools mcp__drawer__*`, no extensions but MCP, no context files, skills or templates | `pi`, then `/login` |
| `gemini` | `gemini --acp`, one per turn | system settings `tools.core: []` and `mcp.allowed: [drawer]`, an admin policy denying everything but drawer's MCP server, no fs/terminal client capabilities; a permission request or a non-MCP tool call fails the turn | run `gemini` once and log in |

Codex keeps three MCP resource readers (`list_mcp_resources`, `list_mcp_resource_templates`,
`read_mcp_resource`) that cannot be switched off; they could reach only drawer's server, which serves
no resources, and using one fails the turn all the same. The Codex lockdown was verified on 0.170 with `codex debug
prompt-input`; older versions are reported `unavailable`. Gemini is built from its source and docs
(0.70+) and tested against a fake: it has not run on this host.

Pi runs without your own `models.json`/custom providers (it sees the providers you are logged in to),
so a custom default model in your pi settings is not offered; pick a model in Settings.

A provider gets each message as text plus the attached images (`TurnMessage` in `src/provider.ts`). The
text names every attachment on its own. Claude sends SDK image blocks, Codex data URLs, Pi RPC images,
and Gemini ACP image blocks when its prompt capabilities allow them; otherwise Gemini sends text only.

## Configuration (environment)

| Variable | Default |
|---|---|
| `DRAWER_URL` | the server saved by `drawer server <url>` |
| `DRAWER_AGENT_ID` | hostname |
| `DRAWER_AGENT_CONCURRENCY` | `2` |
| `DRAWER_AGENT_STATE` | `${XDG_STATE_HOME:-~/.local/state}/drawer-agent` |
| `DRAWER_AGENT_CLAUDE_BIN` | the Agent SDK's bundled Claude Code |
| `DRAWER_AGENT_CODEX_BIN` | `codex` on the `PATH`, `~/.local/bin`, `~/.bun/bin` or `~/.npm-global/bin` |
| `DRAWER_AGENT_PI_BIN` | `pi`, searched the same way |
| `DRAWER_AGENT_GEMINI_BIN` | `gemini`, searched the same way |

A `*_BIN` must be an absolute path to an existing file (executable, except Claude Code's, which may be
a `.js` the SDK runs with node); a bad one stops the runner at start-up with the reason. Settings in the
web app shows each runner's resolved path, read-only.

## Install as a user service

    cp agent/drawer-agent.service ~/.config/systemd/user/
    # edit DRAWER_URL (the server's address) and WorkingDirectory (this checkout; the unit assumes ~/drawer)
    systemctl --user daemon-reload
    systemctl --user enable --now drawer-agent

## Check

    systemctl --user is-active drawer-agent
    journalctl --user -u drawer-agent -n 50
    curl -s "$DRAWER_URL/api/runners"     # the runner must be listed

## Develop

    DRAWER_URL=http://127.0.0.1:3951 bun agent/src/main.ts
