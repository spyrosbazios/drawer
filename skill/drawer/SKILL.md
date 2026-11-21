---
name: drawer
description: Use when designing 3D-printable parts in OpenSCAD (a bracket, enclosure, clip, tray, adapter, assembly), when a part must meet dimensions or fit another object, when looking up or recording notes about 3D designs, when importing a model from Printables, Thingiverse, MakerWorld, Cults3D or MyMiniFactory, or when the user says "in drawer" or "my 3D projects". drawer is a self-hosted CAD workspace for agents: you write the model and the spec through the `drawer` CLI, the server measures every model and decides when a part is done.
---

# drawer

drawer is an agent-only CAD workspace on one server. You model parts in OpenSCAD through the `drawer` command.
A person states what they need and reviews; **the server measures every model against its spec (the gates) and
says whether a part is done. You cannot mark anything done.** The built-in drawer agent uses the same API.

## First, every session

1. `drawer guide`: the modelling guide. **It is the method; follow it.** It is not repeated here, and it can
   change on the server, so read it each session instead of relying on memory.
2. `drawer overview <project> --text`: brief, project memory, parts with status, printer, materials, library.

This skill only covers what the guide cannot: the command for each step, the rules of the CLI, and how to read
what comes back. First-time setup of the command on a machine: [../README.md](../README.md) (`drawer server <url>`).

## Rules of the CLI

- **One central store, no local project files.** Everything is read and written through `drawer`. A scratch
  file in `/tmp` (a spec to feed `--spec`, a model to feed `write --from`) is input only, never the copy that counts.
- A file argument is `<project>/<path>` (`box/parts/lid.scad`); a part argument is `<project>/<id>` (`box/lid`).
  `_library` is the shared project: its parts are `_library/<id>`. It has a fixed layout (the guide's "The
  library"); a write anywhere else is refused with `invalid` and the message names the allowed places.
- **Add `--text` to every command you read.** Piped output is JSON (every field of the API, plus local picture
  paths); `--text` is the compact form this skill describes. `cat` and `guide` always print text.
- **Rev-guarded writes.** `cat` prints `rev <rev>` on stderr. Creating a file needs no rev; overwriting
  (`write --rev`), `edit --rev` and `rm --rev` need the rev you read. A stale rev is **exit 2: re-`cat`, redo
  the change from the new text; never retry blind.** The person may have changed the file in the web app.
- Write a real `-m` on every write: what changed and why. It is the history the person and you read later.
- Exit codes: 0 ok, 1 error (message on stderr), 2 conflict, 3 not found. `forbidden` is exit 1: only a person
  can do it (waiving a gate, for one), in the web app. Say what you need and why; do not look for a way round.
- Renders and sections are downloaded to `~/.cache/drawer/renders/`; the commands print the paths. **Open the
  images with your image Read tool and look at them**; the numbers cannot show a feature on the wrong side.

## The guide's workflow, as commands

| Step in the guide | Command |
|---|---|
| Read first | `drawer overview <p> --text`; `drawer cat <p>/<ref>`; `drawer measure <p>/refs/x.stl --text` to measure a reference; `drawer search <p> <words>`, `drawer context` for older notes. New job: `drawer new <slug> --title t --brief "<what is needed>" [--material m] [--strictness s]` |
| Ask once | In your conversation with the person; there is no command |
| Write the spec | `drawer part <p>/<id> --spec spec.json` (shape: [references/specs.md](references/specs.md)); flags `--title --class --material --strictness --source --description` change one field of an existing spec |
| Model | `drawer write <p>/parts/<id>.scad -m "..." < model.scad` (first write: no `--rev`); then `drawer cat` and `drawer edit --rev` for changes |
| Read the report | It arrives with every write and edit of the model or spec: the `.scad` check, then the report. `drawer report <p>/<id> --text` gets it again |
| Tune a value | `drawer report <p>/<id> --param wall=2.4 --text` (what-if, nothing written), then `drawer set <p>/<id> wall=2.4 -m "..."` |
| Measure | `drawer measure`, `slice --axis z --at 5`, `probe --from x,y,z --axis x`, `section --axis x --at 0` (PNG), on any `.scad` or mesh |
| Attempts | `drawer attempts <p>/<id>` (tree, `*` = current), `drawer restore <p>/<id> <rev-id>`, `drawer compare <p> <a> <b>` (`lid@r12`, `refs/x.stl`) |
| Assembly | `drawer assembly <p> --set assembly.json` (shape: [references/specs.md](references/specs.md)); `drawer assembly <p> --text` re-reads it |
| Stop honestly | `drawer report <p>/<id> --require-passed` exits 1 unless the status is `passed`; `drawer parts <p> --text` and `drawer assembly <p> --text` for the whole job |
| Record what you learned | `drawer note <p> "<text>" --category decision`; structured notes with `edit`/`write`. Grammar: [references/notes-grammar.md](references/notes-grammar.md) |
| After a print | `drawer printed <p>/<id> ok\|issue "<what happened>"`, then a note with the numbers |

`write`/`edit`/`set`/`restore` wait for the evaluation (a few seconds to a minute). `--no-report` skips the wait.
A model that does not parse is still written: the check and the report tell you why.

## Reading a report

```
draft 4/6  box/lid  Lid  (printed, PETG, standard)  revision r41
size 40 x 30 x 12.5 mm, volume 8.13 cm3, 1234 triangles, 10.3 g
fail    Bore for the M3 screw  [dim:bore]  measured 3.1 mm, expected 3.4 ±0.1 mm
        hint: increase hole_d by 0.3
        at 10, 5, 6
fail    Thinnest wall  [min_wall]  measured 0.8 mm, expected >= 1.2 mm
        hint: raise wall to at least 1.6
pass    Builds a solid  [parses]
...
next:
  1. Bore for the M3 screw: increase hole_d by 0.3
params: wall=1.6
pictures:
  sheet  /home/you/.cache/drawer/renders/<key>/sheet.png
  iso    /home/you/.cache/drawer/renders/<key>/iso.png
```

- First word: `passed` (every gate passes or is waived), `draft` (builds, a gate fails), `failed` (does not parse or
  makes no solid), `empty` (no model yet), `pending` (not evaluated yet). `4/6` is gates passed of gates measured.
- Gates, failing first: `fail`, then `warn` (a warning is a failure under `functional`), then `pass`, `waived`
  (a person accepted it), `skip` (could not be measured, usually because `parses` failed). `[dim:bore]` is the
  id of the spec dimension; `at` is where on the part. Fix the first failing gate, write, read again.
- `next` is the server's advice, most important first. `what-if` in the first line means `--param` values were
  tried and nothing was written; the status is not the part's.
- Report `passed` only when the server says so. If you stop with a failing gate, say "not done" and name it.
  Do not edit a spec to make a model pass unless the requirement changed or the measurement was aimed at the
  wrong place, and then say so.

An assembly report reads the same, with gates `parts`, `clash`, `mate:<id>`, `floating`, `bom`, then `pairs`
(gap and overlap per pair) and `bom`.

## Beyond modelling

- **Import** a model: `drawer preview <url>` shows what a site offers (and any `blocker`); `drawer import <p> <url>`
  downloads into `<p>/refs/<name>/` with `source.md`. Keep the licence; link derived work with `based_on`.
  `drawer new <slug> --from <url>` starts a project from an import. Missing files are listed as skipped: say so
  instead of inventing geometry.
- **Hand a job to drawer's own agent:** `drawer ask <p> "<message>"`, follow with `drawer session <id> --text`,
  talk with `drawer say <id> "<message>"`; `drawer sessions [p]` lists them. `--attach <local-file>` (repeatable)
  on `ask` and `say` sends a photo, mesh or datasheet with the message. Answer the agent's open question with
  `drawer answer <id> <question-id> --pick <n>` or own words; a question marked `(pick any)` takes several
  `--pick`s (`drawer help answer`).
- **Attachments a person sent to a session:** `drawer attachments <session-id>` lists them (id, name, kind, where
  filed); `drawer attachment <id> -o <local>` downloads one to look at; `drawer file-attachment <id> refs/<name>.<ext>`
  files it into the project as one revision. File what is worth keeping, under a name that says what it is.
- `drawer agents` shows which
  providers are ready (`--provider claude|codex|pi|gemini`); only a person changes them, in the web app's Settings.
- Version history: `drawer history <p> [path]`; ids work with `cat --at`, `render --at`, `report --at`.

Every command with its flags and output: [references/commands.md](references/commands.md); `drawer help <cmd>`
gives the same on the machine.
