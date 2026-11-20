# drawer command reference

`drawer help` lists everything; `drawer help <cmd>` and `drawer <cmd> --help` give details. A file argument is
`<project>/<path>`; a part argument is `<project>/<id>`. Server: `DRAWER_URL`, else saved by `drawer server <url>`.
Author recorded on writes: `DRAWER_AUTHOR` (default `agent`).

Output: JSON (one document, the API's field names, plus local picture paths where a command downloads images)
when stdout is not a terminal or with `--json`; `--text` forces the compact text. `cat` and `guide` print text
always; `context` prints text and takes `--json`. Errors: one line on stderr. Exit codes: 0 ok, 1 error (also
`forbidden`: a person must do it in the web app), 2 conflict, 3 not found.

## Project and files

| Command | Does |
|---|---|
| `server [<url>]` | verify `/api/health` and save the URL; no argument shows the current one |
| `health` | server version, OpenSCAD version or `unavailable` |
| `projects` | list projects, newest change first (no library) |
| `new <slug> [--title t] [--description d] [--from url] [--brief "<text>"] [--material m] [--strictness s]` | create; `--brief` is what is needed, in the person's words (`brief.md`); `--material`/`--strictness` are what new parts start from |
| `ls <project> [dir]` | tree with kind and size; exit 3 for a missing dir |
| `cat <file> [--at id]` | content to stdout, `rev <rev>` to stderr |
| `info <file>` | kind, size, rev, mesh size, facts, links in and out, SCAD outline |
| `write <file> [--rev r] [-m msg] [--from local] [--no-report]` | body from stdin or `--from`; without `--rev` it creates (exit 2 if the file exists). A `.scad` prints the check; a part's model or spec then prints the report |
| `edit <file> --rev r --old s --new s [--all] [-m msg] [--no-report]` | exact-string replace, `--old` must occur once unless `--all`; same feedback as `write` |
| `rm <file> --rev r` / `rm <dir> --recursive` | delete |
| `mv <file> <new-path> [-m msg]` | rename inside the project |
| `get <file> [-o local]` | download (`-o -` to stdout) |
| `render <file> [--views a,b] [--size n] [--at id]` | server render; downloads sheet and views, prints their paths, mesh size, ECHO log |
| `search <project> <words...> [--kind k] [--limit n]` | full text over one project's notes, SCAD and text (`_library` for the library) |
| `context <file> [--depth 2] [--max-bytes n]` | the file plus everything linked to or from it |
| `history <project> [path] [--limit n]` | revisions, newest first; ids work with `cat --at`, `render --at`, `report --at` |
| `note <project> "<text>" [--file f] [--category c] [-m msg]` | append `- [c] text` to `notes/log.md` (category `note` by default) |
| `reindex` | rebuild the index |
| `import <project> <url> [--name n] [--file-id id]...`, `preview <url>` | import a model page into `refs/<name>/`; show what it would fetch |

## Parts, reports, measuring

| Command | Does |
|---|---|
| `guide` | the modelling guide, markdown on stdout. Read it first |
| `overview <project>` | brief, project memory, parts with status, assembly, references, notes, printer, materials, library |
| `parts <project>` | parts with status and failing gates |
| `part <project>/<id> [--title --class --material --strictness --source printed\|bought --description] [--spec file.json]` | create a part or change its spec; `--spec` is a `PartSpecBody` ([specs.md](specs.md)), flags win; flags alone change the existing spec |
| `report <project>/<id> [--param name=value]... [--at id] [--require-passed]` | the verdict: status, gates, next steps, pictures. `--param` is a what-if (nothing written); `--at` a past revision; exit 0 whatever the status, `--require-passed` exits 1 unless `passed` |
| `set <project>/<id> name=value... [-m msg] [--no-report]` | write parameter values into the model's parameter block (one revision), then print the report |
| `measure <file> [--param name=value]... [--at id]` | shells, watertight, base, overhang, thinnest wall; downloads the render |
| `slice <file> --axis z --at 5` | cross-section outlines: area, centre, size, best-fit circle (`--json` has the points) |
| `probe <file> --from x,y,z --axis x` | inside material or air, and the length of that run |
| `section <file> --axis x --at 0 [--size 800]` | PNG of the part cut at the plane; prints its local path |
| `attempts <project>/<id>` | every model revision as a tree, `*` marks the current one |
| `restore <project>/<id> <rev-id> [--no-report]` | make an old attempt's model current; the next write branches from it |
| `compare <project> <a> <b>` | `a`, `b`: a part id or a path, optionally `@<rev-id>`; deviation of b from a, volume and size deltas, both sheets |
| `assembly <project> [--set file.json]` | the assembly report; `--set` replaces `assembly.json` first ([specs.md](specs.md)); exit 3 without an assembly |
| `printed <project>/<id> ok\|issue "<note>"` | record how a print of the current revision turned out |

`measure`, `slice`, `probe` and `section` work on any `.scad` or mesh: a part's model, a reference, a library part.

## Sessions (drawer's own agent)

| Command | Does |
|---|---|
| `sessions [project]` | sessions, newest first |
| `session <id> [--since version]` | the items: messages, tool calls, questions with options |
| `ask <project> "<message>" [--attach <local-file>]... [--provider p] [--model m]` | start a session; the message may be empty with `--attach` |
| `say <session-id> "<message>" [--attach <local-file>]...` | send a message to a session |
| `attachments <session-id>` | the files attached to a session's messages: id, name, kind, size, where filed |
| `attachment <attachment-id> [-o local]` | download an attachment (default: its name in the current directory; `-o -` stdout) |
| `file-attachment <attachment-id> <path> [--rev r] [-m msg]` | copy an attachment into its project at `<path>`; `--rev` replaces an existing file |

## Conflict handling

Exit 2 prints the file's current rev. Procedure: `drawer cat <file>`, read what changed, redo your intended change
against the new text with the new rev. `write` without `--rev` on an existing file is also exit 2: read it first,
then pass `--rev`.

## Pictures

Renders, sections and sheets are cached in `${XDG_CACHE_HOME:-~/.cache}/drawer/renders/<key>/` (the key is a content
hash: kept, never re-downloaded, safe to delete). Open them with your image Read tool; look at the sheet first,
then single views.
