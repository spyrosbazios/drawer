# Notes grammar

Source of truth: docs/SPEC.md "Notes grammar". The folders stay openable in Basic Memory and Obsidian.

## What the server extracts

| You write | It becomes |
|---|---|
| `- [category] text` | a fact: category, text, file, line number |
| `- relation_name [[target]]` | a link with that relation |
| `- [[target]]` | a link, relation `relates_to` |
| `[[target]]` in any other place | a link, relation `links_to` |
| `- [ ] todo` / `- [x] done` | nothing (checkboxes are not facts) |
| frontmatter `title:` | file title; other keys ignored |
| `use <f>` / `include <f>` / `import("f")` in SCAD | links `uses` / `includes` / `imports` |

Facts show up in `drawer info <file>`; links in `info` (in and out), `context` and the web app's graph.

## Category vocabulary for 3D work

Use these so searches and reading are predictable; invent a new category only when none fits.

| Category | For |
|---|---|
| `decision` | a choice made and the reason: `use heat-set inserts, not nuts: thin wall` |
| `constraint` | a hard limit: `must fit the 256 mm bed`, `max 3 g` |
| `measurement` | a measured dimension of a real thing, with units and what was measured |
| `print-setting` | slicer or printer settings that worked: layer height, infill, supports, orientation |
| `fit` | how parts mated after printing, with clearance and material |
| `learned` | a lesson that is not a decision: `bridges over 30 mm sag in PLA` |
| `todo` | work still to do (not a checkbox, so it is searchable as a fact) |

Write one self-contained fact per line: a reader who sees only that line (in search output) should understand it.
Put numbers and units in the text.

## Relation vocabulary

| Relation | Meaning |
|---|---|
| `main_part` | the part or file that is the project's primary design (put in `AGENTS.md`), e.g. `[[parts/lid.scad]]` |
| `prints_as` | what a design is printed as: a mesh, a plate, a multi-part layout |
| `based_on` | derived from an import or another design |
| `uses` | depends on a library module, note or measurement |
| `supersedes` | replaces an older file or decision (link the old one) |

A relation line is a list item with the relation name (words and underscores) before `[[target]]`.

## How targets resolve

In this order, first match wins:
1. exact project-relative path: `[[src/arm.scad]]`
2. path relative to the linking file
3. unique basename in the project, with or without extension: `[[arm]]`, `[[arm.scad]]`
4. `Library: x` or `_library/x` goes to the library project: `[[Library: tolerances.md]]`
5. `other-slug/path` goes to another project: `[[bracket/src/arm.scad]]`

Unresolved links are kept and resolve when the target appears, so write the link first if you will create the
file next. A basename that exists twice in a project does not resolve at step 3; use the full path.

SCAD `use`/`include`/`import` resolve relative to the file, then the project root, then `_library`.

## Template for a new note

```
---
title: Fit log
---
# Fit log

- [fit] lid 0.2 mm clearance too tight in PETG, 0.3 works
- [learned] first-layer squish shrinks holes by about 0.1 mm
- uses [[Library: tolerances.md]]
```

Then add `- notes/fit.md: fit results per print` to the index in the project's `AGENTS.md`.
