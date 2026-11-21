# Changelog

All notable changes to drawer. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version is one semver number for the whole repository, set by the git tag (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## Unreleased

### Added

- The agent can let you pick several answers to a question: its options show as checkboxes, and your own words can go
  with the picks. From a terminal: `drawer answer <session> <question> --pick <n>...`. An answer is now a list
  everywhere in the API (`answers`); stored sessions read as before.

### Changed

- Settings: the agents are a list beside the one you pick. The list shows each agent's status and its on/off switch;
  the rest (what the runners found, the default model, extra models) is in the pane next to it.
- Workspace: each side panel has its own fold button, and a folded one comes back from that end of the menubar.
  Project settings moved from the header to a Project menu in the menubar, which every view now has; its menus carry
  icons. The header keeps only add and the app menu, whose button is a gear.
- A new project shows an animation while the agent works on it, in place of the line "The agent is on it."
- 3D viewers: the cube in the corner can be dragged to turn the camera, and its faces, edges and corners go to that
  view. Realistic shading (View menu) lights the model with a room and a sun and drops its shadow on a floor. The
  axis of a section cut is picked beside its slider, in the canvas.

### Fixed

- A question from the agent is drawn as markdown, like the rest of what it says.
- The conversation follows the agent as it writes, until you scroll up.

## 0.1.1 - 2026-11-21

### Fixed

- A fresh clone starts. The `data/` folder now comes with the repository; before, Docker created it as root and the
  server stopped at once because it could not write there.
- The server can run as your own user when it is not 1000: set `DRAWER_UID` and `DRAWER_GID` in `.env`. OpenSCAD
  did not start under any other user.

## 0.1.0 - 2026-11-21

The first public release.

### Added

- An agent-only CAD workspace: you write a brief and review, an agent models each part in OpenSCAD, and the server
  renders every model, measures the mesh against the part's spec and decides its status. Nothing a client sends can
  set it.
- Parts with a spec (dimensions with tolerances, the material, how the part is made) and gates: it builds, it is one closed body,
  it fits the bed, each dimension measures within tolerance, walls, overhangs and bed contact. Every attempt is kept
  and can be compared or restored.
- Assemblies: parts and bought components placed together, with mates, clearances and clash checks.
- Agent sessions in the web app: a conversation with the built-in agent, its tool calls, its questions, images and
  files you attach, and a review panel where you waive a gate, change a parameter or record a print result.
- The `drawer` CLI and a skill, so any coding agent can do what the built-in one does, through the same HTTP API.
- A runner for the built-in agent that gives the model drawer's tools and nothing else: no shell, no file system,
  no web. It drives Claude Code, Codex, Pi or Gemini with the login each has on the runner's host; Settings picks the
  default provider and model, and a session can name its own.
- Projects as plain folders, each a git repository the server manages; notes as the project's memory, with facts and
  links that are indexed and searched.
- Import from Printables, Thingiverse, MakerWorld, Cults3D and MyMiniFactory, with the files, images, author and licence.
- A web app that installs on a phone, in light and dark: a 3D viewer with sections and measurements, the attempt
  tree, the report, a markdown reader.
- One Docker image for amd64 and arm64 with OpenSCAD (Manifold), BOSL2 and MCAD inside.

### Security

- The server refuses requests from other websites: no CORS headers, writes only from its own origin, and a request is
  answered only for an IP address, `localhost` or a name in `DRAWER_ALLOWED_HOSTS` (DNS rebinding).
- The port is published on loopback unless `DRAWER_BIND` says otherwise, and a server run from source listens on
  `127.0.0.1` by default.
- The importer connects to public addresses only, on every redirect, and to the address it checked.
- 3MF files are unpacked with a size limit. The container runs unprivileged, with a memory cap and no capabilities.
- Which program the runner executes is set on the runner's own host (`DRAWER_AGENT_<PROVIDER>_BIN`), never through
  the API, and model names are checked before they reach a provider's command line.
