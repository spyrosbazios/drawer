# Security

<!-- reviewed: 2026-11-20 -->

## The model: no sign-in, a private network

drawer has **no authentication**. Anyone who can reach the server's port can read, write and delete every project,
talk to the agent, and take the place of the agent runner. This is deliberate: the network is the only gate. A login
on every device and every agent would add friction without keeping out anyone the network does not already.

## What "private network" means in practice

- The port is published on `127.0.0.1` only by default (`DRAWER_BIND` in `.env`). To use drawer from other devices, set
  `DRAWER_BIND` to the address of a private interface (a VPN or a Tailscale tailnet address), or keep loopback and put
  a reverse proxy in front that is itself only reachable from a network you control.
- Every device that can reach it, and every other service on the same network that could be compromised, can read and
  delete your projects. Share the network only with people you would hand the folder to.
- **Never** expose it publicly: no `0.0.0.0` on a machine a network you do not control can reach, no router port
  forward, no public reverse proxy or tunnel, no Tailscale Funnel.
- Docker's published ports are not filtered by every host firewall. Check from another machine on your LAN that the
  port is not reachable unless you meant it to be.
- A server run without Docker (`bun server/src/main.ts`) listens on `127.0.0.1` unless `DRAWER_HOST` says otherwise.

## What the server does about your own browser

A private network does not keep out the web pages you open on it, so the server does:

- It sends no CORS headers: a page on another origin cannot read a response.
- A request that changes anything is refused when its `Origin` is not the server's own host and port, or when the
  browser marks it cross-site. JSON routes accept `application/json` only, which a cross-site form cannot send.
- No `GET` route changes a project. Some fill a cache when it is stale (a part's report, a cover), so a page that
  knows your server's address can make it spend CPU on a render; it learns nothing from it.
- A request is answered only when its `Host` is an IP address, `localhost`, or a name listed in
  `DRAWER_ALLOWED_HOSTS`. This is what stops DNS rebinding, where a page reaches your server through a name it
  controls. Reach drawer by a name (`drawer.lan`, a MagicDNS name) and you must list that name; a reverse proxy must
  pass `Host` through unchanged. `X-Forwarded-Host` is never trusted.

## Models are untrusted text

A `.scad` file is written by a language model, or downloaded from a model site, and OpenSCAD runs it.

- **A model can read any file the server process can read**, with `include`, `use` and `import()`: another project's
  files, the shared library, the container's own files. It cannot write outside the render's output and it cannot
  read environment variables, so import tokens stay out of reach. Projects on one server are therefore **not isolated
  from each other**: treat everything on a server as readable by every agent working on it. Sandboxing OpenSCAD is
  planned; until then, keep projects that must not meet on separate servers.
- A render is stopped after 120 seconds, with everything it started. Renders run one at a time. The container's memory
  is capped by `DRAWER_MEMORY`: a model that reaches the cap is killed by the kernel, and if the server goes with it,
  Docker restarts the container.
- The container runs as an unprivileged user with every capability dropped; the application's files are read-only to it.

## The agent

- The built-in runner gives the model drawer's own tools and nothing else: no shell, no file system, no web, for
  every provider (Claude Code, Codex, Pi, Gemini). It stops a turn that shows or tries any other tool, and it keeps the
  host user's own agent settings, MCP servers, skills and hooks out. How each provider is held to that:
  [agent/README.md](agent/README.md).
- The runner is not in the container: it runs as you, on a host with your provider logins. Which program it executes
  is decided on that host only (`DRAWER_AGENT_<PROVIDER>_BIN`, or the CLI it finds itself). Nothing sent to the server
  can change it, and a model name is checked before it reaches a command line.
- Each provider's CLI inherits the runner's environment. Run the runner with only the variables its providers need.
- Text from a model site (a description, a `.scad` someone published) reaches the agent when you import it. It can
  mislead the agent like any text can; what the agent can then do is limited to those tools: edit its own project and
  the shared library, and read as described above.
- The runner uses the provider logins of the machine it runs on. What you write to the agent, and the files it reads,
  go to the provider of that session.
- Anyone who can reach the server can also poll it as a runner, take a queued session and answer in the agent's
  place. That is the no-sign-in model again: it gives them your message and the project, which they could read anyway.
- An outside agent using the `drawer` CLI has whatever else you gave that agent. drawer does not restrain it.

## Imports

- Importing makes the server fetch from a model site, and one agent tool does it too. The importer connects to public
  addresses only, on every redirect and for every image: never loopback, private ranges, a tailnet, or a cloud
  metadata address, and it connects to the address it checked. Report any bypass.
- Import tokens (`.env`) are sent only to their own site and never appear in an error or a response.
- Downloads are capped (200 MB a file, 20 MB an image) and 3MF archives are unpacked with a size limit.
- A model you import keeps its author's licence, recorded in its `source.md`. drawer does not check that you may
  reuse it.

## Backups

drawer has no backups of its own. `data/` is the only copy of your projects: back it up yourself.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: on this repository, open the **Security** tab and choose **Report a
vulnerability** (a security advisory). Please do not open a public issue for a vulnerability. There is no email address
for reports.

In scope: ways a web page can read or change a server it is not served from, bypasses of the `Host` check or the
importer's address check, a path that reaches outside a project through the API, disclosure of an import token, a way
for the built-in agent to get a tool that is not drawer's, a way for a request to the server to choose what the runner
executes, and a way for a client to set a part's status. Out of scope:
the absence of sign-in, which is the documented model, and a model reading files the server can read, which is
described above.
