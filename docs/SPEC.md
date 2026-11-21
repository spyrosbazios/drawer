# drawer — spec

<!-- reviewed: 2026-11-21 -->

drawer is a self-hosted, agent-only CAD workspace. A person states what they need and reviews; an
agent models; the server measures every model against its spec and decides when a part is done. It
runs on one machine and is reached over a private network. No authentication
([`SECURITY.md`](../SECURITY.md)).

Nobody models by hand: there is no sketcher and no code editor. A person changes intent only (the
brief, a spec, parameter values, a waiver, a print result) and talks to the agent.

Shapes of every request and response: [`shared/src/api.ts`](../shared/src/api.ts). This file explains
behaviour. Where the two disagree, `api.ts` wins and this file gets fixed.

## Model

- **One central store.** Files live only on the server. Agents and the web app read and write through
  the HTTP API (agents through the `drawer` CLI). Nothing is synced to the machine an agent runs on;
  the CLI keeps only a throw-away cache of rendered PNGs so the agent can look at them.
- **A project is a folder.** A brief, parts, an optional assembly, references and notes. Any other
  file is allowed too: markdown, `.scad`, meshes (`.stl`, `.3mf`, `.obj`, `.ply`), images, PDFs.
- **A part is a spec plus a model.** `parts/<id>.part.json` says what must be true; `parts/<id>.scad`
  is the agent's attempt at it. The server evaluates the model against the spec (the *gates*) and
  reports a status. No client can set a status.
- **One API for every agent.** The agent built into drawer and an outside agent using the `drawer`
  CLI call the same routes; there is no private path.
- **The library is a project** with the reserved slug `_library` and a fixed layout (Store layout): the
  printer profile, the materials, shared notes, bought parts, shared OpenSCAD modules and their references.
  Every route that takes a project slug accepts it. It cannot be deleted and is not listed by
  `GET /projects`. A person sets it up by talking to the agent in it (the guide's "Setting up the
  library"); the printer and materials are also forms in the web app's settings.
- **Files are the truth; the index is derived.** SQLite (FTS5, links, facts, mesh info) can be
  deleted and rebuilt from the files (`POST /api/reindex`, `drawer reindex`).
- **Revisions are the server's business.** Each project folder is a git repository that only the
  server touches: every write is one commit, with the author and message from the request. Clients
  never see git; they see `Revision` objects. `.git` never appears in a tree.

## Store layout

`DRAWER_DATA` (default `./data`):

```
projects/<slug>/          one git repo per project
  project.json            { title, description, cover, source, createdAt, defaults }
  brief.md                what is needed, in the person's words
  AGENTS.md               project memory: decisions, constraints, what was learned
  parts/<id>.part.json    a part's spec (PartSpec)
  parts/<id>.scad         a part's model
  assembly.json           how the parts go together (AssemblySpec); optional
  notes/  refs/           working notes; imported models, photos, datasheets
projects/_library/        shared by every project, created on first start; nothing else may be written here
  AGENTS.md               what the library holds and how to use it
  printer.json            PrinterProfile: bed, nozzle, minimum wall, overhang limit, clearances
  materials.json          { materials: Material[] }
  <name>.md  notes/**.md  shared notes (tolerances, materials, the printer's quirks)
  parts/<id>.part.json    a bought part's spec (source "bought"); parts/<id>.scad its envelope
  lib/**.scad             shared OpenSCAD modules (`use <lib/x.scad>`)
  refs/**                 datasheets, drawings and meshes of bought parts
sessions/<id>.json        an agent session's state; <id>.jsonl its items, one JSON object per line
sessions/attachments/     files sent with messages: <id>.json (descriptor, project, session), <id>.bin
cache/meshes/<key>/       mesh.stl, optional proxy.stl, meta.json and derived measurements
cache/renders/<key>/      view PNGs, sheet.png and render metadata
cache/reports/<key>.json  part and assembly reports
cache/thumbnails/         project thumbnails: <key>.png, and <key>.fail for a cover that does not render
index.db                  SQLite
```

`project.json` is written by the server only and is hidden from the tree and the file routes.

`projects/` and `sessions/` are the truth. `cache/` and `index.db` are derived and can be deleted.

## Files, revs and writes

- `rev` = first 16 hex chars of the SHA-256 of the file's bytes.
- `GET /projects/:slug/files/<path>` returns the raw bytes, with `x-drawer-rev`. `?at=<revisionId>`
  reads a past revision.
- `PUT /projects/:slug/files/<path>` writes raw bytes. Creating: no `x-drawer-rev` needed; sending one
  for a path that does not exist is `not_found`. Overwriting: `x-drawer-rev` is required and must equal
  the current rev, else `409 conflict` with the current rev in the body. `x-drawer-rev: *` overwrites
  unconditionally (used by uploads in the web app, never by the agent skill).
- `POST /projects/:slug/edit/<path>` replaces an exact string, with the same semantics as Claude Code's
  Edit tool: `old` must occur exactly once unless `replaceAll`; otherwise `422 edit_no_match`. Guarded
  by `rev` like PUT. Text files only.
- `DELETE /projects/:slug/files/<path>` needs `x-drawer-rev`. Deleting a directory: `?recursive=1`, no rev.
- `POST /projects/:slug/move` renames a file or directory.
- Parent directories are created on write. Paths are normalised; `..`, absolute paths, `.git` and
  `project.json` are `400 invalid`.
- Max upload 200 MB.
- Every write: commit, reindex the touched files, emit a `DrawerEvent`.
- A write or edit of a `.scad` file returns `check`: OpenSCAD's errors and warnings for the new text,
  from a parse-and-evaluate pass that builds no geometry. The write succeeds either way.
- A write that touches a part (its model or its spec) returns the part id in `part` and queues an
  evaluation of it.
- Structured files (`*.part.json`, `assembly.json`, the library's `printer.json` and
  `materials.json`) are validated on every write, by whatever route: an invalid one is `400 invalid`
  and nothing is written. Waivers in a spec can only change through the waive route.
- **The library's layout is enforced** on every write, edit, upload, move, filed attachment and import into
  `_library`: a path outside it is `400 invalid`, and the message names the allowed places. A library part's
  spec must say `source: "bought"`. `printer.json` and `materials.json` cannot be deleted or moved
  (`400 invalid`). Files already outside the layout stay readable, movable into it and deletable.

## File kinds

| Kind | Extensions | Viewer |
|---|---|---|
| `markdown` | `.md` | reader + edit |
| `scad` | `.scad` | code + render split |
| `mesh` | `.stl` `.3mf` `.obj` `.ply` | 3D viewer |
| `image` | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` | image |
| `pdf` | `.pdf` | embedded PDF |
| `text` | `.txt` `.json` `.yaml` `.yml` `.toml` `.csv` `.gcode` `.py` `.js` `.ts` `.sh` `.dxf` and any file that decodes as UTF-8 under 1 MB | code view |
| `binary` | everything else (`.step`, `.f3d`, …) | download |

## Notes grammar (markdown)

Borrowed from Basic Memory so the folders stay openable there and in Obsidian.

- Frontmatter (optional): `title`. Other keys are ignored.
- **Fact:** a list item `- [category] text` → `Fact`. Checkboxes (`[ ]`, `[x]`) are not facts.
- **Relation:** a list item `- relation_name [[target]]` → `Link` with that relation. A bare
  `- [[target]]` is `relates_to`. `[[target]]` anywhere else is `links_to`.
- **Targets** resolve in this order: exact project-relative path; path relative to the linking file;
  unique basename match in the project (with or without extension); `Library: x` or `_library/x` → the
  library project; `other-slug/path` → another project. Unresolved links are kept (`to: null`) and
  resolve when the target appears.
- **SCAD** files yield links too: `use <f>` → `uses`, `include <f>` → `includes`, `import("f")` →
  `imports`, resolved relative to the file, then the project root, then `_library`.

## Index and search

- FTS5 over: path, title (frontmatter title, first heading, or filename), and text content of
  markdown, scad and text files. Mesh files are indexed by name plus their `MeshInfo` as text.
- Search is per project, never global: `GET /projects/:slug/search?q=&kind=&limit=` → `SearchResponse`,
  bm25 ranked (the library is searched by its slug). `q` is plain words (the server escapes FTS syntax);
  a trailing `*` is added to the last word for prefix match.
- `GET /projects/:slug/info/<path>` → `FileInfo`.
- `GET /projects/:slug/context/<path>?depth=2&maxBytes=4000` → `ContextResponse`: the file, then
  everything reachable over links in either direction, breadth-first, at most 30 nodes.

## Rendering

- Input: a `.scad` or mesh file. Output: binary STL, one PNG per view, a contact sheet, `MeshInfo`.
- Engine: OpenSCAD nightly (Manifold) run headless. It creates its own EGL context, so no X server or
  xvfb is needed. The STL is a full Manifold render; the PNG views use preview mode with edges shown,
  because a full render draws orthographic views in one flat colour and loses the outlines.
- Meshes are converted to binary STL by the server and viewed through a generated wrapper `.scad` that
  `import()`s it.
- The command is `DRAWER_OPENSCAD` (default `openscad`). In the container image it is on `PATH`.
  `OPENSCADPATH` is set to `<project>:<projects/_library>` so `use <lib/x.scad>` finds library files.
- The mesh key hashes the file format and bytes, dependency bytes reported by OpenSCAD (`-d`),
  parameter overrides and the OpenSCAD version for SCAD. The preview key hashes the mesh key,
  views, size and OpenSCAD version. Both include a pipeline version. A preview cache hit sets `cached: true`.
- Renders run one at a time (a queue); timeout 120 s → `render_failed`.
- A running render reports each stage change as a `render_progress` event on `/events` (`queued`,
  `analysing`, `geometry`, `views` once per view, `sheet`, then `done` or `failed`), with `step` of
  `total` work units finished. The web app animates its progress display from these.
- `GET /renders/<key>/<file>` serves the outputs (immutable cache headers, `ETag`, `304` on a match).
- A failed render returns `422 render_failed` with OpenSCAD's stderr in `message`, paths made project-relative.
- Views: `iso` (55,0,25), `front` (90,0,0), `top` (0,0,0), `side` (90,0,90), all with
  `--viewall --autocenter`, orthographic except `iso`.
- The worker computes `MeshInfo` from the triangles, including the bounding box, count and `closed`.
  A closed surface has exactly two triangles per edge. Only closed meshes with consistent winding
  and nonzero signed volume report a volume.
- The renderer reduces mesh previews over 200,000 triangles by vertex clustering and returns a
  `proxy` URL for `proxy.stl`. Measurements and the `mesh` URL use all triangles.
- **Thumbnails.** `Project.cover` is the chosen cover, else the first of the part models, other `.scad`
  files (shallowest first), meshes. `Project.thumbnail` is `/api/projects/<slug>/thumbnail/<key>.png`, where
  the key is a hash of the cover's path, its rev, the revs of every file it uses (the index's SCAD links)
  and the renderer's version: it changes only when the picture can. The first request renders the cover
  with the default views and size (a part model's evaluation has usually rendered exactly that already) and
  scales the iso view to 480 px; the PNG is kept under `cache/thumbnails/` and served immutable with
  `ETag`. A cover that does not render is remembered (`<key>.fail`), the request is `404`, a `project`
  event goes out, and the thumbnail moves to the next candidate; `null` when none is left or there is
  nothing to draw. A key that is not the project's current one and was never drawn is `404`.

## Scan intake

Drop an STL, OBJ, 3MF or PLY onto the project tree and choose **Add scan**. Give STL, OBJ and PLY
their original units (`mm`, `cm`, `m` or `in`). For 3MF the embedded units take precedence. PLY
accepts ASCII and both binary byte orders. Save the uploads as ordinary reference files when you
want to keep their original bytes.

Intake accepts a raw file of at most 200 MB and 2,000,000 triangles. Export a triangulated surface
for point clouds, and decimate larger meshes before uploading. In one revision the server writes
`refs/<name>/scan.stl` in millimetres and `refs/<name>/source.md`. An existing name returns 409.
The note records the original filename, units, triangle counts, removal of degenerate triangles
and pieces below 1% of total surface area, closedness and noise. Intake welds vertices with a
tolerance of one ten-thousandth of the median nonzero edge length, corrects winding, and discards
the original upload. On an open component it keeps the side supported by most of the source area
when making the winding consistent. The noise estimate is the median distance of a vertex to the
least-squares plane of its neighbours.

## Scanned parts and alignment

Set a part's `source` to `"scanned"` and give it `scan: { file, rotate, translate }`. The file is a
project mesh, typically `refs/<name>/scan.stl`. Rotations are in degrees about x, y and z in that
order, then translation in millimetres. This part has no OpenSCAD file, parameters or attempts.
The server evaluates only `parses` and its dimension gates, using the placed mesh. A measurement
can address `parts/<id>.part.json` to use that frame. Assemblies place scanned parts the same way
as other parts. The library continues to hold bought parts.

The index records a `scans` dependency from the spec to its mesh. A mesh write, deletion or
reappearance queues the part. Evaluation and report keys include the referenced file revision.
Historical evaluation uses the spec and mesh from the requested revision.

`POST .../align/<path>` proposes a pose without making a revision. With no target it uses the
largest fitted plane as the datum, the longest remaining direction for x, and the box corner or
main revolution axis as the origin; every other plane with at least 90 % of the datum's area is
offered in `ambiguous` as the other way up, with `rms` null. With `to`, the renderer tries the 24 proper principal-axis
orientations and refines them with point-to-plane ICP. The result includes the RMS distance and
other poses with similar scores when alignment is ambiguous.

## Parts and gates

A part id is `[a-z0-9][a-z0-9-]*`. `PUT /projects/:slug/parts/:id` creates the part or replaces what a
client may set in its spec; unknown fields are `400`. Missing fields take the project's `defaults`
(`material`, `strictness`), `class: ""`, `source: "printed"`, no dimensions. Deleting a part removes
its spec and model in one revision. The model is written like any file (`PUT .../files/parts/<id>.scad`).

**Evaluation** runs after every write that touches the part, one part at a time, and on
`POST .../parts/:id/evaluate` (which joins a running evaluation of the same state instead of starting
another). Steps: check → render (all four views) → analyse the mesh → measure the spec's dimensions →
gates. The report is cached under a key of everything it depends on (model, its SCAD dependencies,
spec, printer profile, material, OpenSCAD version), so an unchanged part is never measured twice.
`GET .../parts/:id/report` returns the current report, waiting for a running evaluation.

`evaluate` with `params` evaluates the model with those top-level values overridden and nothing
written (`whatIf: true`); it never changes the part's status. `POST .../parts/:id/params` writes the
values into the model's parameter block as one revision.

**Gates.** Each yields `pass`, `fail`, `warn`, `skipped` or `waived`, with what was measured, what was
expected, and a hint.

| Gate | Passes when | Applies |
|---|---|---|
| `parses` | OpenSCAD evaluates the model without errors and builds a non-empty solid | always |
| `solid` | one connected, watertight body | printed or bought |
| `fits_bed` | the bounding box fits the printer's bed (x and y may swap) | printed |
| `dim:<id>` | the measured value is within the dimension's range | always, one per spec dimension |
| `match:<id>` | both area shares within ±`tol` reach `share` (default 0.95) | printed, one per match |
| `lint` | first line is a `//` description; at least one Customizer parameter; no top-level `$fn` above 128. More than 6 unexplained numeric literals inside modules is a `warn` | printed, `standard` and up |
| `base` | bed contact is at least 20 mm² and 5 % of the footprint | printed, `standard` and up |
| `overhang` | unsupported overhang area is within the printer's limit; over it is `warn` under `standard`, `fail` under `functional` | printed, `standard` and up |
| `min_wall` | the thinnest wall is at least the material's or the printer's minimum. Left out when the spec has its own `min_wall` dimension | printed, `standard` and up |

Under `functional` every `warn` becomes `fail`. A gate that cannot be measured (no mesh because
`parses` failed) is `skipped`. A waived gate counts as passing and shows the waiver's reason.

**Status.** `empty`: no model. `failed`: `parses` or `solid` fails. `draft`: any other gate fails.
`passed`: none fails. `pending`: written but not evaluated yet. `passed` and `total` count the gates
that are not `skipped`; `pass`, `warn` and `waived` count as passed.

**Dimensions** are measured on the mesh, never taken from the model's variables:

- `size`, `envelope`, `volume`: from the bounding box and the signed volume.
- `hole`, `boss`: the mesh is cut at `axis` = `at`; among the openings (`hole`) or the outlines of
  material (`boss`) the one whose centre is nearest `near` gets a best-fit circle. No such outline at
  that cut, or one that is not round (fit error above 2 % of the diameter), fails with that as the detail.
- `gap`, `wall`: a ray through `from` along `axis` in both directions; the run of air or material
  that contains the point. A `gap` whose point is inside material, a `wall` whose point is in air, or
  a point that lies on the surface, fails and says so.
- `min_wall`: from the thickness field (see Measuring).

**Matches** compare the printed model to another part in the same project. Each entry in
`matches` has `id`, `label`, `to` (the target part id), positive `tol` in millimetres, and optional
`share` in (0, 1]. The index records a `matches` dependency on the target spec. Report freshness
follows the target's state, including changes to a referenced scan. The gate reports both area
shares and the place of the largest sampled difference.

**Waivers** (`POST .../parts/:id/waive`) are a person's decision: the author `agent` gets
`403 forbidden`. An empty reason removes the waiver. `parses` and `solid` cannot be waived. There is
no authentication, so this is a rule the agent's tools keep (they have no waive tool), not a lock. **Print results** (`POST .../parts/:id/prints`)
append to the spec's `prints`.

**Attempts.** Every revision that changed a part's model is an attempt. `POST .../parts/:id/restore`
makes an old attempt's model current again (a revision with the message `restore <revisionId>`); it is
not a new attempt. The next model write becomes a child of the restored attempt, so the attempts form
a tree. The tree is derived from the project's history; nothing else stores it.

**Project status** rolls up the parts and the assembly: `overall` is `failed` if anything failed,
else `draft`, else `pending`, else `passed`; `empty` without parts.

## Measuring

All of it works on any `.scad` or mesh file (a part's model, a reference, a library part), is computed
on the rendered mesh in the measuring worker, and is cached beside the mesh. Slice, probe and
section skip the standard previews. Measure and compare also return previews.

- `POST /projects/:slug/measure/<path>` → mesh info, analysis and a render.
  - *Shells*: connected components. *Watertight*: every edge has exactly two triangles.
  - *Base*: area of downward faces within 0.05 mm of the lowest z.
  - *Overhang*: area of faces whose normal points down more steeply than the printer's
    `maxOverhangDeg` from vertical, excluding the base.
  - *Wall thickness* (closed surfaces only): from each triangle's centre a ray goes into the material against the normal;
    the distance to the first exit is that triangle's thickness. The reported minimum is the smallest
    thickness that covers at least 1 mm² and 0.2 % of the surface, so one sliver triangle does not
    decide it. The per-triangle values are served as `thickness.f32`.
- `POST .../slice/<path>` → the closed outlines of the cross-section at `axis` = `at`, each with area,
  bounding box and a best-fit circle. On an open mesh, section endpoints within the weld tolerance
  join, and any remaining open chains appear in `open`. With `shadow: true` in place of `at`, the server
  returns the union of the projected triangles along the axis.
- `POST .../features/<path>` → up to 40 planes, cylinders and spheres, largest first. Each fit reports
  its origin, direction, diameter and length where applicable, RMS, largest residual and coverage.
  `features.f32` holds the feature index per full-resolution triangle (-1 for none). The result also
  specifies the matching field and mesh URLs for display, using a remapped field for a light mesh.
- `POST .../fit/<path>` with `{ at: [x, y, z], kind? }` → the fit on the surface nearest that point,
  or 422 when no fit agrees with the surface. Both fitting routes work from the mesh cache.
  They grow connected patches using normals and distance, then use least-squares fits following
  [Forbes](https://eprintspublications.npl.co.uk/5050/) and [Shakarji](https://nvlpubs.nist.gov/nistpubs/jres/103/6/j36sha.pdf).
  On a mesh file, the viewer can colour by feature or fit the picked point.
- `POST .../probe/<path>` → whether a point is inside material and how long the run of material or
  air through it is along an axis. Open meshes return `422 render_failed`.
- `POST .../section/<path>` → a PNG of the part cut at `axis` = `at`, lower side kept.
- `POST /projects/:slug/compare` → signed distance statistics in both directions, area shares within
  the supplied positive `tol` (default 0.2 mm), volume and size deltas. B-to-A statistics appear at
  the top level of `deviation`. A-to-B statistics appear in `reverse`. The `at` point is the largest
  sampled difference in either direction. Signs follow angle-weighted pseudonormals on both open
  and closed meshes. The deviation field holds the mean signed distance per triangle of the
  returned B mesh. The match gate uses the same area-weighted surface samples. Sample spacing
  scales with tolerance. A comparison that would exceed eight million samples in either direction
  asks for a larger tolerance or a retessellated mesh.

## Assembly

`assembly.json` places copies of parts (`instances`, at least one, each a part id, a rotation and a
translation) and says how they must meet (`mates`). A part of the library is `_library/<id>`. `PUT
/projects/:slug/assembly` validates and writes it and returns the report; `GET` returns the current
report (`404` without an assembly); a write to any part it uses re-evaluates it.

For every pair that is mated or whose bounding boxes come within 1 mm, the server measures the gap between the surfaces. For two closed meshes it also measures shared
volume. For an open surface, `overlapCm3` is null and `penetration` reports depth behind the
surface and its limit. The open-scan clash limit is the larger of the printer's sliding clearance
and twice the scan's measured noise. This threshold is a decision for review.

| Gate | Passes when |
|---|---|
| `parts` | every instance's part exists, has a model and is not `failed`; `warn` while any is `draft` |
| `clash` | no closed pair shares more than 0.5 mm³ and no open pair exceeds its depth limit, except pairs mated as `press` |
| `mate:<id>` | `clearance`: no overlap and the gap is within `min`..`max`. `contact`: no overlap and gap ≤ 0.05 mm. `press`: the two overlap or touch |
| `floating` | every instance is within 0.5 mm of another (skipped with a single instance) |
| `bom` | every bought part is a library part |

The bill of materials counts instances per part; a printed part's mass is its volume times its
material's density.

## Agent sessions

A session is one conversation between a person and a modelling agent about one project. Its state and
items live in `DRAWER_DATA/sessions/`, so any browser attaches to the same session and nothing is lost
when a tab closes.

The agent itself runs in an **agent runner**: a separate process (`agent/`, run on the host with the
provider's own login) that long-polls `POST /runner/work`, drives the provider's agent, and writes what
happens back as items. The server never talks to a model provider. Providers sit behind an adapter in
the runner: `claude` (Claude Code through the Claude Agent SDK), `codex` (`codex app-server`), `pi`
(`pi --mode rpc`) and `gemini` (`gemini --acp`); how each is kept to drawer's tools:
[`agent/README.md`](../agent/README.md).

- `POST /projects/:slug/sessions` creates a session with its first message: status `queued`. Without
  `provider` it gets the settings' `defaultProvider`; without `model`, that provider's `defaultModel`
  (null: the provider's own default). A provider turned off in settings is refused (`invalid`), and so
  is a `model` that is not a model id (`isModelId` in `shared/src/api.ts`: letters, digits and
  `. _ : / @ + -`, starting with a letter or digit, no `..` or `//`; it reaches a CLI's arguments).
- Every poll carries the runner's status of every provider it knows (`ready`, `disabled`,
  `not_installed`, `signed_out`, `unavailable`, with version, models, a message and the CLI path it
  resolved, `binary`) and whether it
  takes turns now (`accepting`). `GET /runners` shows exactly that.
- A runner's poll claims a `queued` session of a provider that is `ready` on that runner and enabled
  in settings, while it is accepting: status `working`, the pending
  user messages go out as a `turn`, together with the guide (`GET /guide`) and the provider's resume
  handle from the last turn.
- The runner appends items (`assistant` text, `tool` calls with a one-line summary, `reasoning`,
  `question`, `notice`) and patches `activity`. When the turn ends it sets `idle` (or `failed` with `error`). A
  `resume` handle it patches must be a provider session id (`isResumeHandle`: letters, digits and
  `. _ : -`); the runner checks the model and the handle again before a turn.
- An item's `seq` is its place and never changes. The session's `version` goes up with every item
  appended or changed (a tool call finishing replaces its item, as does a thought growing or closing; an
  answer fills its question), and the
  item carries that version, so `GET /sessions/:id?since=<version>` returns exactly what a client has
  not seen.
- `reasoning` is what the model itself reports thinking (`reasoningId`, `text`, `status` running/done,
  `seconds`), shown in the thread and nothing else: never sent back to a model, never searched. A later
  append with the same `reasoningId` replaces the item in place, so a thought is one item that grows and
  closes. The runner opens it at the first text, rewrites it at most once a second, keeps the last 4000
  characters, and closes every open one when the turn ends. A provider or model that reports no thinking
  leaves no item; nothing is made up.
- A message sent while a turn runs stays pending; when the turn ends the session is `queued` again.
- `ask`: the agent's question appears as a `question` item and the status is `waiting`;
  `POST /sessions/:id/answer` records the answer, which the runner's `GET /sessions/:id/answer` long
  poll returns; the status goes back to `working`. The agent marks a question `multiple` when the person
  may pick several options. An answer is a list, each entry a picked option verbatim or the person's own
  words: exactly one for a single question, one or more distinct entries for a multiple one; the server
  rejects any other count. A list keeps every entry whole whatever it contains, where a joined string
  would make a separator ambiguous.
- `POST /sessions/:id/stop`: a working session's runner receives `stop` on its next poll and
  interrupts the agent; the status is `stopped`. A new message queues it again.
- A runner that has not polled for 60 s is forgotten; its working sessions become `failed` ("the agent
  runner went away"). The same happens at once when a runner polls with a new `boot` nonce: the old
  process is gone. `GET /runners` lists the runners seen in the last minute.
- Only the runner that holds a session may append items to it or patch it (`runner` and `boot` in the
  query); anyone else gets `409 conflict`, so a late write from a lost runner cannot touch a newer turn.
- A turn that fails while messages are pending is queued again once, like a turn that ended.

**Attachments.** A person uploads a file first (`POST /projects/:slug/attachments?name=<file name>`, raw
bytes, at most 100 MB) and names its id in the next message (`attachments`, at most 10). The `user` item
then carries each `SessionAttachment`; its `kind` is decided as for a project file of that name and
content. An id goes with one message of its own project only. The bytes stay under
`DRAWER_DATA/sessions/attachments/`, outside the project, until someone files the attachment:
`POST /attachments/:id/file` copies it into its project through the normal write path (one revision,
events, index, evaluations), sets `filedAs`, and changes the item (new version, `session` event). Unsent
uploads are dropped after a day; deleting a session or its project deletes its attachments. The runner
sends attached PNG, JPEG, GIF and WebP images (up to 4 MB each, the newest 8 of a turn) to the model as
image input and lists every attachment in the message text; a provider without image input gets the text.

The agent gets drawer's tools and nothing else: no shell, no file system, no web. The tools are thin
calls to the routes in this file. A turn in which the provider shows or tries any other tool fails.

## Settings

`DRAWER_DATA/settings.json`, one document for the server (not a project's), shape `Settings`: the
default provider for new sessions and, per provider, `enabled`, `defaultModel` and `customModels`
(model ids, as for a session). A missing file means the defaults (every provider on, `claude` the
default); a file that does not parse, or holds an invalid value, stops the server with the reason; a key
that is not a setting is dropped and gone from the file after the next write. Which CLI a runner runs is
never a setting: anyone who reaches the API can change these, so the runner's host picks its CLIs
(`DRAWER_AGENT_<KIND>_BIN`, [`agent/README.md`](../agent/README.md)) and reports the resolved path. `PATCH /settings` changes only the fields sent, is validated as a whole (the default
provider must stay enabled), is refused for the author `agent` (`forbidden`), and emits `settings`.
Runners read `GET /settings` before every poll. There are no keys in it: each provider uses its own
CLI login on the runner's host.

## Importing

`POST /import/preview { url }` → what the site offers. `POST /projects/:slug/import` → downloads into
`refs/<name>/`: the model files, up to 8 images, and `source.md` (title, author, license, URL,
description). One commit, author `import`.

The importer connects to public addresses only, on every hop: the URL, each redirect and every image
link. An IP literal is checked as it is; a name is resolved and refused if any of its addresses is
loopback, private, carrier-grade NAT (Tailscale), link-local (cloud metadata), multicast, reserved, or an
IPv6 form that embeds IPv4 (mapped, NAT64, 6to4, Teredo); `localhost` and `*.localhost` are always
refused. The connection then goes to the address that was checked, with the original name as Host, TLS
SNI and certificate name, so a name that re-resolves in between cannot redirect it. A request whose URL
carries a credential (MyMiniFactory's key) follows no redirect to another origin.

| Site | Metadata | Files | Needs |
|---|---|---|---|
| Printables | yes | yes | nothing (public GraphQL, undocumented) |
| Thingiverse | yes | yes | `THINGIVERSE_TOKEN` |
| MakerWorld | yes | only with `MAKERWORLD_TOKEN` | Bambu account token |
| Cults3D | yes | never (site policy) | `CULTS3D_USER`, `CULTS3D_KEY` |
| MyMiniFactory | yes | no (needs OAuth) | `MYMINIFACTORY_KEY` |
| anything else | page title, og:image, og:description | no | – |

A missing credential is not an error for preview: `blocker` says what is missing and metadata comes
from the generic scraper. Secrets come from the environment only; they are never logged or returned.

## HTTP routes (all under `/api`)

Every request, the web app included, must name the server by an IP literal, `localhost`, or a host name
listed in `DRAWER_ALLOWED_HOSTS` (comma-separated, no scheme or port; e.g. a MagicDNS name or the name a
reverse proxy serves); any other `Host` is `403 forbidden` (DNS-rebinding defence). A reverse proxy must
pass the client's `Host` through. A request other than GET/HEAD is `403 forbidden` when its
`Sec-Fetch-Site` is `cross-site` or its `Origin` is not the same host and port as its `Host`; clients
that send no `Origin` (the CLI, the runner) are unaffected. The server sends no CORS headers. A JSON body
must come with `content-type: application/json`. No GET changes anything. The server listens on
`DRAWER_HOST` (default `127.0.0.1`) and `PORT`.

| Method | Path | Body → Result |
|---|---|---|
| GET | `/health` | → `Health` |
| GET | `/events` | SSE stream of `DrawerEvent` |
| GET | `/projects` | → `{ projects: Project[] }` (newest change first; no `_library`) |
| POST | `/projects` | `CreateProjectBody` → `Project` (201) |
| GET | `/projects/:slug` | → `Project` |
| PATCH | `/projects/:slug` | `PatchProjectBody` → `Project` |
| DELETE | `/projects/:slug` | → 204 (moves the folder to `DRAWER_DATA/trash/<slug>-<timestamp>`) |
| GET | `/projects/:slug/thumbnail/<key>.png` | → PNG (immutable), or 404 |
| GET | `/projects/:slug/tree` | → `TreeResponse` |
| GET | `/projects/:slug/files/<path>` | → raw bytes (`?at=`, `?download=1`) |
| PUT | `/projects/:slug/files/<path>` | raw bytes → `WriteResult` |
| DELETE | `/projects/:slug/files/<path>` | → `{ revisionId }` |
| POST | `/projects/:slug/edit/<path>` | `EditBody` → `WriteResult` |
| POST | `/projects/:slug/move` | `MoveBody` → `{ revisionId }` |
| GET | `/projects/:slug/info/<path>` | → `FileInfo` |
| GET | `/projects/:slug/history` | `?path=&limit=` → `HistoryResponse` |
| GET | `/projects/:slug/context/<path>` | → `ContextResponse` |
| GET | `/projects/:slug/search` | `?q=&kind=&limit=` → `SearchResponse` |
| POST | `/projects/:slug/render/<path>` | `RenderBody` → `RenderResult` |
| POST | `/projects/:slug/scans` | `?name=&filename=&units=`, raw mesh bytes → `ScanResult` (201) |
| POST | `/projects/:slug/import` | `ImportBody` → `ImportResult` |
| POST | `/import/preview` | `{ url }` → `ImportPreview` |
| GET | `/renders/<key>/<file>` | → bytes |
| GET | `/guide` | → the modelling guide, `text/markdown` |
| GET | `/library/profile` | → `LibraryProfile` (with `printerIsExample` while printer.json is the starter's) |
| GET | `/projects/:slug/overview` | → `ProjectOverview` |
| GET | `/projects/:slug/parts` | → `PartsResponse` |
| PUT | `/projects/:slug/parts/:id` | `PartSpecBody` → `PartSummary` |
| DELETE | `/projects/:slug/parts/:id` | → `{ revisionId }` |
| GET | `/projects/:slug/parts/:id/report` | → `PartReport` |
| POST | `/projects/:slug/parts/:id/evaluate` | `EvaluateBody` → `PartReport` |
| POST | `/projects/:slug/parts/:id/params` | `SetParamsBody` → `WriteResult` |
| POST | `/projects/:slug/parts/:id/waive` | `WaiveBody` → `PartSummary` |
| POST | `/projects/:slug/parts/:id/prints` | `PrintBody` → `PartSummary` |
| GET | `/projects/:slug/parts/:id/attempts` | → `AttemptsResponse` |
| POST | `/projects/:slug/parts/:id/restore` | `RestoreBody` → `WriteResult` |
| POST | `/projects/:slug/measure/<path>` | `MeasureBody` → `MeasureResult` |
| POST | `/projects/:slug/align/<path>` | `AlignBody` → `AlignResult` |
| POST | `/projects/:slug/features/<path>` | `FeaturesBody` → `FeaturesResult` |
| POST | `/projects/:slug/fit/<path>` | `FitBody` → `Feature` |
| POST | `/projects/:slug/slice/<path>` | `SliceBody` → `SliceResult` |
| POST | `/projects/:slug/probe/<path>` | `ProbeBody` → `ProbeResult` |
| POST | `/projects/:slug/section/<path>` | `SectionBody` → `SectionResult` |
| POST | `/projects/:slug/compare` | `CompareBody` → `CompareResult` |
| GET | `/projects/:slug/assembly` | → `AssemblyReport` |
| PUT | `/projects/:slug/assembly` | `AssemblySpec` → `AssemblyReport` |
| POST | `/projects/:slug/assembly/evaluate` | → `AssemblyReport` |
| GET | `/sessions` | `?project=` → `SessionsResponse` (newest first) |
| POST | `/projects/:slug/sessions` | `CreateSessionBody` → `Session` (201) |
| GET | `/sessions/:id` | `?since=<version>` → `SessionDetail` |
| POST | `/sessions/:id/messages` | `SessionMessageBody` → `Session` |
| POST | `/sessions/:id/stop` | → `Session` |
| POST | `/sessions/:id/answer` | `AnswerBody` → `Session` |
| DELETE | `/sessions/:id` | → 204 |
| POST | `/projects/:slug/attachments` | `?name=`, raw bytes → `SessionAttachment` (201) |
| GET | `/attachments/:id` | → raw bytes (`?download=1`) |
| POST | `/attachments/:id/file` | `FileAttachmentBody` → `FileAttachmentResult` |
| GET | `/runners` | → `RunnersResponse` |
| POST | `/runner/work` | `RunnerPoll` → `RunnerWork` (long poll, `wait` ≤ 30 s) |
| GET | `/settings` | → `Settings` |
| PATCH | `/settings` | `PatchSettingsBody` → `Settings` (people only) |
| POST | `/sessions/:id/items` | `?runner=&boot=`, `NewSessionItem` → `SessionItem` (runner) |
| PATCH | `/sessions/:id` | `?runner=&boot=`, `RunnerSessionPatch` → `Session` (runner) |
| GET | `/sessions/:id/answer` | `?question=&wait=` → `{ answers: string[] \| null }` (runner, long poll) |
| POST | `/reindex` | → `{ files: number }` |

Anything not under `/api` serves the built web app (`web/dist`), with `index.html` as the SPA fallback.

## CLI (`drawer`)

One Bun/TypeScript file, no state except `${XDG_STATE_HOME:-~/.local/state}/drawer/server.json` (the
server URL; `DRAWER_URL` overrides) and `${XDG_CACHE_HOME:-~/.cache}/drawer/renders/`. Output is JSON
when stdout is not a TTY or `--json` is given; otherwise short human text. Exit 0 ok, 1 error (message
on stderr), 2 conflict, 3 not found. A file argument is `<project>/<path>`.

```
drawer server <url>                      set and verify the server
drawer projects                          list projects
drawer new <slug> [--title t] [--from <url>]
drawer ls <project> [dir]                tree
drawer cat <file> [--at <rev-id>]        content on stdout, rev on stderr ("rev <rev>")
drawer info <file>                       FileInfo
drawer write <file> [--rev r] [-m msg] [--from <local-file>]   body from stdin or --from
drawer edit <file> --rev r --old s --new s [--all] [-m msg]
drawer rm <file> --rev r                 (dir: --recursive)
drawer mv <file> <new-path> [-m msg]
drawer get <file> [-o local]             download a binary
drawer render <file> [--views iso,front] [--size 800]   renders on the server, downloads the sheet and views, prints their local paths
drawer search <project> <words...> [--kind k]
drawer context <file> [--depth 2]
drawer history <project> [path]
drawer note <project> "<text>" [--file notes/log.md] [--category c]   append a fact line (creates the file)
drawer import <project> <url> [--name n]
drawer scan add <project> <file> --name n [--units mm|cm|m|in]
drawer reindex

drawer guide                                 the modelling guide the server gives every agent
drawer overview <project>                    brief, memory, parts with status, printer and materials
drawer parts <project>                       parts with status
drawer part <project>/<id> [--title t] [--class c] [--material m] [--strictness s] [--source printed|bought|scanned]
            [--description d] [--spec file.json]     create the part or replace its spec (--spec: a PartSpecBody; flags win)
drawer report <project>/<id> [--param name=value]... [--at <rev-id>]   the server's verdict; --param is a what-if
drawer set <project>/<id> name=value...      write parameter values into the model
drawer measure <file>                        mesh info and analysis of any model
drawer align <file> [--to part-or-path]      propose a frame or align to another model
drawer features <file> [--at <rev-id>]       planes, cylinders and spheres
drawer fit <file> --at x,y,z [--kind plane|cylinder|sphere]
drawer slice <file> --axis z (--at 5 | --shadow)
drawer probe <file> --from x,y,z --axis x    run of material or air through a point
drawer section <file> --axis x --at 0 [--size 800]   downloads the PNG, prints its local path
drawer attempts <project>/<id>               the attempt tree
drawer restore <project>/<id> <rev-id>       make an old attempt current
drawer compare <project> <a> <b> [--tol mm]  a, b: part ids or paths, optionally @<rev-id>
drawer assembly <project> [--set file.json]  the assembly report; --set replaces assembly.json first
drawer printed <project>/<id> ok|issue "<note>"
drawer sessions [project]                    agent sessions
drawer session <id>                          one session's items
drawer ask <project> "<message>" [--attach f]...   start a session (--attach: send a local file)
drawer say <session-id> "<message>" [--attach f]...
drawer attachments <session-id>              files attached to the session's messages
drawer attachment <id> [-o local]            download one
drawer file-attachment <id> <path> [--rev r] [-m msg]   copy it into its project
```

`write` and `edit` print the `check` for a `.scad` file, and for a part's model they wait for the
evaluation and print the report, so the feedback arrives without a second command.

## Code layout

Bun workspaces: `shared/` (API types, module contracts), `server/` (store, index, parts and gates,
sessions, HTTP), `render/` (OpenSCAD pipeline, mesh maths and measuring), `importers/` (one module per
site), `cli/` (the `drawer` command and the typed client), `agent/` (the agent runner: provider
adapters and the agent's tools), `web/`, `skill/drawer/` (the skill for outside agents), `docker/`.

## Deployment

One container: the OpenSCAD dev image plus Bun, running the server, which also serves the web app.
The agent runner is not in the container: it runs on the host as the user unit `drawer-agent`, with
`DRAWER_URL` pointing at the server, so it can use the provider login that is already there.
`docker-compose.yml` at the repo root pulls the published image, publishes port 3050 on loopback unless
`DRAWER_BIND` names another address, and keeps the data in a bind mount (`./data`). Building from the
checkout is `docker-compose.build.yml`; a deployment's own additions go in `docker-compose.override.yml`.
Deployment settings: [`.env.example`](../.env.example).
