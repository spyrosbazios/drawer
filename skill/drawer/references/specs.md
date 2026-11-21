# Spec and assembly files

<!-- reviewed: 2026-11-21 -->

The JSON you feed to `drawer part --spec` and `drawer assembly --set`. Shapes: `shared/src/api.ts` (`PartSpecBody`,
`Dimension`, `AssemblySpec`); behaviour: `docs/SPEC.md`. The server validates both and answers `invalid` with the
reason; nothing is written then. Lengths are millimetres in the model's own coordinates (the print orientation).
Keep these files in `/tmp`: they are input, the server holds the copy.

## Part spec: `drawer part <project>/<id> --spec spec.json`

```json
{
  "title": "Lid for the tray",
  "class": "enclosure lid",
  "description": "Slides over the tray, held by two snap arms",
  "source": "printed",
  "material": "PETG",
  "strictness": "standard",
  "dimensions": [
    { "id": "width", "label": "Outer width", "kind": "size", "axis": "x", "nominal": 40, "tol": 0.3 },
    { "id": "bore", "label": "Bore for the M3 screw, compensated", "kind": "hole", "axis": "z", "at": 6, "near": [10, 5], "nominal": 3.4, "tol": 0.1 },
    { "id": "slot", "label": "Cable slot", "kind": "gap", "axis": "x", "from": [20, 15, 4], "min": 6.2 },
    { "id": "rim", "label": "Rim wall", "kind": "wall", "axis": "y", "from": [20, 1, 5], "min": 1.6 },
    { "id": "thin", "label": "No wall thinner than", "kind": "min_wall", "min": 1.2 }
  ]
}
```

- Only `title` is required. Missing fields take the project's defaults (`material`, `strictness`), `class: ""`,
  `source: "printed"`, no dimensions. `source: "bought"` is for hardware (screws, magnets): no printability gates.
- Do not send `waivers` or `prints` (`400`): waivers are a person's decision, prints go through `drawer printed`.
- A dimension's range is `nominal` ± `tol`, or `min` and/or `max`. `id` is unique in the spec
  (`[a-z0-9][a-z0-9_-]*`) and names the gate `dim:<id>`.

| `kind` | Fields | Measures |
|---|---|---|
| `size` | `axis` | extent of the bounding box along the axis |
| `envelope` | `box` `[x,y,z]` | the bounding box must fit inside the box |
| `hole` | `axis`, `at`, `near` `[a,b]` | diameter of the round opening in the cross-section at `axis` = `at`, nearest to `near` (the other two coordinates, in x-y-z order) |
| `boss` | `axis`, `at`, `near` `[a,b]` | the same for a round outline of material: a pin, a peg, a round body |
| `gap` | `axis`, `from` `[x,y,z]` | free distance through the point (it must be in air) |
| `wall` | `axis`, `from` `[x,y,z]` | material thickness through the point (it must be in material) |
| `min_wall` | none | the thinnest wall anywhere must be at least `min` |
| `volume` | none | solid volume in cm3 |

Check a `hole`, `boss`, `gap` or `wall` point with `drawer slice` / `drawer probe` before relying on it.

## Assembly: `drawer assembly <project> --set assembly.json`

```json
{
  "title": "Tray with lid",
  "instances": [
    { "id": "tray", "part": "tray", "translate": [0, 0, 0], "rotate": [0, 0, 0] },
    { "id": "lid", "part": "lid", "translate": [0, 0, 12], "rotate": [0, 0, 0] },
    { "id": "screw1", "part": "_library/m3x8-screw", "translate": [10, 5, 12], "rotate": [0, 0, 0] }
  ],
  "mates": [
    { "id": "lid-on-tray", "label": "Lid seats on the tray", "a": "tray", "b": "lid", "fit": "clearance", "min": 0.1, "max": 0.3 },
    { "id": "screw-in-lid", "label": "Screw presses into the lid", "a": "lid", "b": "screw1", "fit": "press" }
  ]
}
```

- `part` is a part of this project (`tray`) or of the library (`_library/<id>`). `rotate` is degrees about x, then
  y, then z (like OpenSCAD's `rotate()`), then `translate` moves it.
- `fit`: `clearance` (no overlap, gap within `min`..`max`), `contact` (no overlap, gap at most 0.05 mm), `press`
  (may overlap; exempt from the clash gate).
- `--set` replaces the whole file; fetch the current one with `drawer cat <project>/assembly.json` to change it.


## Scanned parts

Use `source: "scanned"` with `scan: { "file": "refs/object/scan.stl", "rotate": [0, 0, 0], "translate": [0, 0, 0] }`.
Save the frame proposed by `drawer align` after checking the views. The placed mesh is measured
through `parts/<id>.part.json`. Record dimensions on this part and use it in assemblies.
