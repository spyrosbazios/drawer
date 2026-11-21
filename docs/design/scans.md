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
| 6 | S6 guide chapter, complete | written alongside each stage, finished here |

Every stage changes `shared/src/api.ts`, the server, the CLI, the agent's tools, the web app and its
mock server together, as the invariant requires.

## Open questions

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
