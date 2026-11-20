import type { MaterialsFile, PrinterProfile } from "@drawer/shared/api";
import { MATERIALS_FILE, PRINTER_FILE } from "@drawer/shared/api";

export interface StarterFile {
  path: string;
  content: string;
}

export const BRIEF_PLACEHOLDER = "What is needed, in the person's words: what the thing is for, where it goes, what it must fit or hold.\n";

export function projectStarter(title: string, brief: string | undefined): StarterFile[] {
  const briefText = brief?.trim() ? `${brief.trim()}\n` : BRIEF_PLACEHOLDER;
  return [
    { path: "brief.md", content: `# ${title}\n\n${briefText}` },
    {
      path: "AGENTS.md",
      content: `---
title: ${JSON.stringify(title)}
---

# ${title}

Project memory. Read this file and [[brief]] first. Shared notes live in the library: [[Library: AGENTS]].

## Decisions and constraints

Record each one as a fact line so it can be found later:

\`\`\`
- [decision] short statement of what was chosen and why
- [constraint] a hard limit (size, tolerance, material)
- [learned] what a render, measurement or print showed
- [question] something still open
\`\`\`

## Layout

- \`brief.md\`: what is needed, in the person's words
- \`parts/<id>.part.json\`: a part's spec (what must be true); \`parts/<id>.scad\`: its model
- \`assembly.json\`: how the parts go together (optional)
- \`notes/\`: working notes, measurements, a log of what was tried
- \`refs/\`: imported models, photos and datasheets (an import writes \`refs/<name>/source.md\`)

The server measures every model against its spec and reports the status; nobody sets it by hand.
Link notes with \`[[target]]\`, or name the relation: \`- implements [[parts/body.scad]]\`.
`,
    },
    { path: "parts/.gitkeep", content: "" },
    { path: "notes/.gitkeep", content: "" },
    { path: "refs/.gitkeep", content: "" },
  ];
}

/** printer.json for a fresh library: a typical 256 mm enclosed FDM machine with a 0.4 mm nozzle. */
export function defaultPrinter(): PrinterProfile {
  return {
    name: "Example FDM printer",
    bed: [256, 256, 256],
    nozzleMm: 0.4,
    layerMm: 0.2,
    minWallMm: 1.2,
    maxOverhangDeg: 45,
    maxOverhangAreaMm2: 100,
    clearance: { sliding: 0.2, press: 0.05 },
  };
}

export function defaultMaterials(): MaterialsFile {
  return {
    materials: [
      { name: "PLA", densityGCm3: 1.24, minWallMm: null, notes: "Stiff and easy; creeps under constant load above 50 C." },
      { name: "PETG", densityGCm3: 1.27, minWallMm: null, notes: "Tougher than PLA; strings, dry it first." },
      { name: "ABS", densityGCm3: 1.04, minWallMm: null, notes: "Heat resistant; warps without an enclosure." },
      { name: "TPU", densityGCm3: 1.21, minWallMm: 1.6, notes: "Flexible; thin walls collapse, print slowly." },
    ],
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The library's structured files; created on every start when missing. */
export function libraryProfileFiles(): StarterFile[] {
  return [
    { path: PRINTER_FILE, content: json(defaultPrinter()) },
    { path: MATERIALS_FILE, content: json(defaultMaterials()) },
  ];
}

export function libraryStarter(): StarterFile[] {
  return [
    ...libraryProfileFiles(),
    { path: "parts/.gitkeep", content: "" },
    {
      path: "AGENTS.md",
      content: `---
title: Library
---

# Library

Shared by every project. Read it before designing anything that will be printed.

- \`printer.json\`: the machine (build volume, nozzle, minimum wall, overhang limit, clearances). The gates read it.
- \`materials.json\`: materials with density and minimum wall. The gates read it.
- \`parts/\`: bought hardware (screws, magnets, bearings), each with \`source: "bought"\`; an assembly uses them as \`_library/<id>\`.
- [[printer]], [[tolerances]], [[materials]] and \`notes/\`: what the numbers do not say.
- \`lib/\`: shared OpenSCAD modules. \`refs/\`: datasheets and meshes of bought parts.

Nothing else can be written here: a printed part or a one-off belongs in its project.

## How to use it

- Link from a project with \`[[Library: printer]]\` (or \`[[_library/printer]]\`).
- OpenSCAD files can \`use <lib/x.scad>\`: library files are on the search path.
- Record knowledge as fact lines: \`- [category] text\`. Prefer one fact per line.
- When a test print teaches something general, add it here, not in the project.

## Notes grammar

- \`- [category] text\` is a fact.
- \`- relation_name [[target]]\` is a relation; a bare \`- [[target]]\` is \`relates_to\`.
- \`[[target]]\` anywhere else is a plain link. Targets resolve by path, then by file name.
`,
    },
    {
      path: "printer.md",
      content: `---
title: Printer
---

# Printer

The numbers (build volume, nozzle, layer height, minimum wall, overhang limit, clearances) are in
\`printer.json\`; change them there. This note holds what they do not capture.

- [printer] describe the machine here: make, enclosure, bed surface #hardware
- [bridge] note how long a bridge holds on this machine #limits
`,
    },
    {
      path: "tolerances.md",
      content: `---
title: Tolerances
---

# Tolerances

Sliding and press clearances per side, and the minimum wall, are in \`printer.json\`. Update them
after every fit test, and record here what the numbers do not say.

- [hole] printed holes come out slightly small; measure and record by how much #fit
- [text] embossed text needs a stroke of about two nozzle widths #detail
`,
    },
    {
      path: "materials.md",
      content: `---
title: Materials
---

# Materials

Densities and minimum walls are in \`materials.json\`. Print settings and behaviour go here.

## PLA

- [material] PLA: nozzle 215 C, bed 60 C #pla

## PETG

- [material] PETG: nozzle 240 C, bed 80 C #petg
`,
    },
  ];
}
