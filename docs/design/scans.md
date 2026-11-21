# Design: working from 3D scans

<!-- reviewed: 2026-11-21 -->

This is the remaining plan for letting a person drop a 3D scan into a project and have
the agent model from it. Each stage moves into [`SPEC.md`](../SPEC.md) in the commit that builds it, and
its section here is deleted in the same commit. When the last stage ships, this file goes.

## Goal

A scan job is one of two things, and every feature below serves one or both:

- **Copy**: model the scanned object itself (a broken knob, a cover that is no longer sold).
- **Fit**: model a new part that goes on, in or around the scanned object (a holder, an adapter, a tray).

The agent cannot click and cannot judge a mesh by eye, so the server has to hand it the scan as numbers:
which surfaces are there, how big, where, and how sure the measurement is. And because the server decides
the status, the scan must also be something a gate can check the model against.

Out of scope, on purpose: tolerance inspection (GD&T), sketch-based reverse engineering, STEP export and
any way for a person to edit a mesh. The agent writing OpenSCAD is drawer's scan-to-CAD.

## The loop

| Step | Who | With |
|---|---|---|
| 1. Drop the scan, say its units | person | scan intake |
| 2. Put it in a sensible frame | agent | `align` |
| 3. Learn what it is made of | agent | `features`, `fit`, `slice`, the views |
| 4. Write the spec from measured values, then the model | agent | parts, as today |
| 5. Check the model against the scan | server | `match` gate (copy), `mate`/`clash` against the scan (fit) |

## Groundwork (no new behaviour)

The remaining groundwork ships with scanned parts.

### G3. A spec can depend on something besides its own model

The index, `stateKey` and the report key follow SCAD links only. A part whose gate reads another part,
or whose model is a mesh file, would keep a stale report.

- A spec's references become index links (`scans` to a file, `matches` to a part), so `dependents()`
  finds them and a write to either re-queues the part.
- `stateKey` and the report key take the referenced file's rev or the referenced part's state key, the
  way an assembly already takes its parts'.

## S1. Scan intake

`measure` and `compare` return preview URLs used by the CLI and web viewer, so they retain preview
generation. The separate mesh cache serves the measurements. Scan previews use the light copy below.

`POST /projects/:slug/scans?name=<name>&units=mm|cm|m|in` with the file as the body (STL, OBJ, 3MF, PLY).
`drawer scan add <project> <file> --name --units`. In the web app: dropping a mesh on a project asks
"is this a scan?" and for its units.

The server normalises once, on the way in, and stores the result. Nothing downstream knows about units.

- Scale to millimetres. STL, OBJ and PLY carry no unit, so `units` is required for them; 3MF's own unit wins.
- Weld vertices (tolerance from the mesh's median edge length), drop zero-area triangles, drop
  connected pieces under 1 % of the total area (scanner debris), orient normals outward.
- Refuse a point cloud (no faces) and a mesh over the triangle limit (see Open questions), with a
  message that says what to do.
- Write `refs/<name>/scan.stl` and `refs/<name>/source.md` in one revision. `source.md` holds facts, in
  the notes grammar: original file name and format, units given, triangles before and after, what was
  removed, whether the surface is closed, the noise estimate.

The original bytes are not kept: a scan is tens of megabytes and every write is a git blob. This is the
one place a stored file is not what the person uploaded, and `source.md` says so.

**Noise estimate**: the median distance of each vertex from the plane fitted to its neighbours. It is the
floor under every tolerance the agent sets from this scan, and the guide says so.

**The light copy.** A scan is drawn (the four views, the browser) from a decimated copy of at most
200 000 triangles, made by vertex clustering and kept in the mesh cache. Everything is *measured* on the
full mesh. `GET /renders/...` serves the light copy as `proxy.stl`.

**Open surfaces.** A scan is rarely watertight. Measurements that rest on "inside" (`probe`, wall
thickness, volume, the sign of a deviation by ray parity) are wrong on an open surface. `MeshInfo` gains
`closed: boolean`; on an open mesh those measurements return `422` with that reason instead of a number,
and the deviation sign comes from the surface normal at the closest point (angle-weighted pseudonormal),
which needs no closed surface.

## S2. A scan as a part

A scanned object is a part: `source: "scanned"`, beside `printed` and `bought`.

```ts
interface PartSpec {
  source: "printed" | "bought" | "scanned";
  /** source "scanned" only: the mesh that is this part's model, and where it sits. No .scad. */
  scan?: { file: string; rotate: Vec3; translate: Vec3 };
  ...
}
```

- Its model is the scan, placed by the transform. It has no `.scad` and no attempts.
- Gates: `parses` (the mesh reads and is not empty) and its `dim:` gates. No `solid`, no printability gates.
- Its dimensions are the **measurement record**: the agent writes "bore, 22.1 ± 0.15" as a `hole`
  dimension on the scanned part, and the server confirms it on the scan. A measurement that the server
  cannot reproduce shows as a failing gate, not as a wrong number in a note.
- Because it is a part, an assembly can place it, and `mate` and `clash` run against the real object
  with no new instance type. On an open scan the shared volume cannot be measured; `clash` then tests
  how deep the other part's surface goes behind the scan's (see Open questions).

This is why G3 exists, and why the frame (S3) has a home in a file.

## S3. Frame: `align`

`POST /projects/:slug/align/<path>` with `{ to?: CompareSide }` → `AlignResult`. A POST that writes
nothing: it proposes, the agent decides and writes the transform into the scanned part's spec.

```ts
interface AlignResult {
  rotate: Vec3; translate: Vec3;
  /** RMS distance after alignment, mm; null without `to`. */
  rms: number | null;
  /** Another pose fits nearly as well (a symmetric object): the alternatives, best first. */
  ambiguous: { rotate: Vec3; translate: Vec3; rms: number }[];
}
```

- **Without `to`** (a datum frame for the scan alone): the largest plane goes down onto z = 0, the
  longest remaining direction along x, the bounding box's corner or the main axis of revolution at the
  origin. Built from S4's features.
- **With `to`** (onto a part or another mesh): starts from the principal axes in all 24 orientations,
  refines each briefly with point-to-plane ICP, then the best fully. Pairs further than three times the
  median distance, or with opposed normals, are left out; poses are scored on all samples so a pose
  cannot win by dropping the hard ones.

Alignment is never part of a gate. A gate reads the transform from the spec, so the same files always
give the same status.

## S4. What the scan is made of: `features` and `fit`

One fitting engine, two ways in.

- `POST /projects/:slug/features/<path>` → every plane, cylinder and sphere the surface holds, largest
  first, at most 40. For the agent: it reads the object as a list.
- `POST /projects/:slug/fit/<path>` with `{ at: Vec3, kind?: FeatureKind }` → the one feature at that
  point. For a person pointing at something in the viewer, and for the agent checking one spot.

```ts
type FeatureKind = "plane" | "cylinder" | "sphere";
interface Feature {
  kind: FeatureKind;
  /** plane: a point on it. cylinder: a point on the axis. sphere: the centre. */
  origin: Vec3;
  /** plane: the normal. cylinder: the axis. sphere: null. */
  direction: Vec3 | null;
  diameter: number | null;
  /** cylinder: its length along the axis. */
  length: number | null;
  /** cylinder and sphere: material outside the surface (a hole) or inside it (a pin). */
  side: "hole" | "boss" | null;
  areaMm2: number;
  /** RMS distance of the surface from the fitted shape, and the largest, mm. All points count. */
  rms: number; maxError: number;
  /** Share of the full shape that the surface covers: 0.5 for half a cylinder. Low coverage means a less certain diameter. */
  coverage: number;
}
```

`features` also writes `features.f32` (the feature's index per triangle, -1 for none), so the viewer can
colour the scan by feature with the field mechanism it already has.

**Method** (published, not taken from another program's code):

- Grow a region from a seed triangle over neighbours whose normal and distance agree with the current
  fit; refit; repeat until it stops growing. `features` seeds from the flattest unclaimed triangles.
- Plane: centroid and the smallest eigenvector of the covariance. Sphere and cylinder: an algebraic
  start, then Gauss–Newton on the true distances with the parameterisations of Forbes and Shakarji.
- The kind is chosen by fit error when not given: the simplest shape within the scan's noise wins.
- Cone and torus are left out until a real part needs them.

**Proof.** The fits are tested against NIST's reference data sets for least-squares geometry, and
against generated shapes with known noise, partial coverage and outliers. No accuracy is claimed in the
docs that a test in the repo does not reproduce.

**Sections.** `slice` on an open mesh closes gaps shorter than the weld tolerance and returns the
outlines that still do not close as `open`, instead of dropping them. `slice` with `shadow: true`
returns the outline of the whole object projected along the axis: the pocket a holder needs.

## S5. Checking the model: the `match` gate

For a copy. On a printed part's spec:

```ts
interface Match {
  id: string; label: string;
  /** The part to match: usually a scanned one. */
  to: string;
  /** Both surfaces must lie within ±tol of each other, mm. */
  tol: number;
  /** Over at least this share of the area. Default 0.95. */
  share?: number;
}
interface PartSpec { matches: Match[]; ... }
```

Gate `match:<id>` passes when at least `share` of the model's area is within `tol` of the scan **and**
at least `share` of the scan's area is within `tol` of the model. One direction alone passes a model
that is missing a boss. Not waivable by the agent, like every gate.

It is a gate of its own, like `mate:<id>`, not a dimension kind: a dimension is one number in a range,
and this is two area shares and a place.

What changes under it: today's `deviation` measures one direction, one point per triangle (so a large
flat triangle is sampled once), with a sign from ray parity. It becomes area-weighted sampling of both
surfaces at a spacing tied to `tol`, the pseudonormal sign, and the area share within a given distance
in its output. `compare` gets the same numbers; there is one deviation, not two.

The gate's `at` is the place of the largest difference, and the deviation field already colours it.

## S6. Guidance

A chapter in [`server/src/guide.md`](../../server/src/guide.md), "Working from a scan", mirrored in the
skill. Its rules:

1. Read `refs/<name>/source.md` first: closed or open, the noise, what was removed.
2. Make the scan a part and give it a frame before measuring anything. Look at the views after `align`;
   if `ambiguous` is not empty, ask the person which way is up.
3. Read `features` before slicing. Take a diameter from a fitted cylinder, never from two points.
4. Trust a feature by its `coverage` and `rms`. Under a third of a cylinder, say the diameter is uncertain.
5. Record each measurement you build on as a dimension on the scanned part, with a tolerance no tighter
   than twice the scan's noise.
6. Model the intent, not the noise: a hole fitted at 5.93 mm is a 6 mm hole. Say which you chose and why.
7. Copy → a `match` on the new part. Fit → an assembly with the scanned part and a `mate` for each
   surface that must meet, with the printer's clearance.
8. A scan does not show what is inside or behind. Ask for a second scan or a calliper reading instead
   of guessing.

## Order

| Stage | Holds | Behaviour changes |
|---|---|---|
| 2 | S1 intake, `closed`, the light copy | a scan can be dropped, viewed and measured |
| 3 | S4 `features`, `fit`, sections on open meshes | the agent can read a scan |
| 4 | G3, S2 scanned parts, S3 `align` | a scan is a part with a frame; `mate` and `clash` reach it |
| 5 | S5 `match`, both-way deviation | a copy can be checked |
| 6 | S6 guide chapter, complete | written alongside each stage, finished here |

Every stage changes `shared/src/api.ts`, the server, the CLI, the agent's tools, the web app and its
mock server together, as the invariant requires.

## Open questions

- **Triangle limit.** 2 million is the proposal; measure the worker's memory and the time of `features`
  on a real scan of that size before fixing it. The 200 MB upload limit already bounds the file.
- **`clash` against an open scan.** Depth behind the surface is the proposal; the threshold (the
  printer's clearance, or the scan's noise) is not decided.
- **A scan in the library.** Bought parts live in `_library`; a scanned bought part would need
  `_library/refs/**` to take a `scan.stl`, which the layout already allows, and `source: "scanned"`
  where the layout demands `bought`. Decide when a real case comes up.
- **Later, not planned here:** a calibrated flatbed photo turned into an outline, as the scan for people
  without a 3D scanner.

## Sources

- A. B. Forbes, *Least-squares best-fit geometric elements*, NPL report DITC 140/89:
  <https://eprintspublications.npl.co.uk/5050/>
- C. M. Shakarji, *Least-squares fitting algorithms of the NIST algorithm testing system*, 1998:
  <https://nvlpubs.nist.gov/nistpubs/jres/103/6/j36sha.pdf>
- NIST algorithm testing, reference data sets:
  <https://www.nist.gov/pml/sensor-science/dimensional-metrology/algorithm-testing>
- Y. Chen, G. Medioni, *Object modelling by registration of multiple range images* (point-to-plane ICP):
  <https://graphics.stanford.edu/~smr/ICP/comparison/chen-medioni-align-rob91.pdf>
- S. Rusinkiewicz, M. Levoy, *Efficient variants of the ICP algorithm*:
  <https://graphics.stanford.edu/papers/fasticp/fasticp_paper.pdf>
- J. A. Bærentzen, H. Aanæs, *Signed distance computation using the angle weighted pseudonormal*:
  <https://doi.org/10.1109/tvcg.2005.49>

[ScanRuler](https://github.com/CNCKitchen/scanruler) showed which features matter. It is AGPL-3.0, so no
code is taken from it; the methods above are the published ones it also builds on.
