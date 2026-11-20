/**
 * End-to-end renders against a real OpenSCAD. Skipped when `version()` is null.
 * Command: $DRAWER_OPENSCAD (default "openscad"). Outputs stay under $DRAWER_RENDER_TEST_DIR
 * when it is set (for looking at them), else under a fresh temp dir.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "fast-png";
import { RenderError } from "@drawer/shared/contracts";
import { createRenderer } from "../src/index";
import { isBinaryStl } from "../src/mesh";
import { cube3mf, cubeAsciiStl } from "./fixtures";

const base = process.env.DRAWER_RENDER_TEST_DIR ?? tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "run-"));
const renderer = createRenderer({ cacheDir: join(root, "cache"), openscadCmd: process.env.DRAWER_OPENSCAD });
const version = await renderer.version();

const project = join(root, "project");
const library = join(root, "my library");
await mkdir(join(project, "src"), { recursive: true });
await mkdir(join(library, "parts"), { recursive: true });

const ALL = ["iso", "front", "top", "side"] as const;
const SLOW = 120_000;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe.skipIf(version === null)(`real OpenSCAD (${version})`, () => {
  test("SCAD cube → STL, four views, sheet, info, log, warnings; second call is cached", async () => {
    const file = join(project, "src", "cube.scad");
    await writeFile(file, 'echo("hello drawer");\nx = undefined_thing;\ncube(10);\n');
    const stages: string[] = [];
    const out = await renderer.render({
      file,
      searchPaths: [project, library],
      views: [...ALL],
      size: 400,
      onProgress: (p) => stages.push(`${p.stage}${p.view ? `:${p.view}` : ""} ${p.step}/${p.total}`),
    });
    expect(stages).toEqual(["queued 0/7", "analysing 0/7", "geometry 1/7", "views:iso 2/7", "views:front 3/7", "views:top 4/7", "views:side 5/7", "sheet 6/7"]);
    expect(out.cached).toBe(false);
    expect(out.dir).toBe(join(root, "cache", out.key));
    for (const name of ["mesh.stl", "iso.png", "front.png", "top.png", "side.png", "sheet.png", "meta.json"]) {
      expect(await exists(join(out.dir, name))).toBe(true);
    }
    expect(isBinaryStl(new Uint8Array(await readFile(join(out.dir, "mesh.stl"))))).toBe(true);
    expect(out.info.triangles).toBe(12);
    expect(out.info.bbox.size).toEqual([10, 10, 10]);
    expect(out.info.volumeCm3).toBeCloseTo(1, 6);
    expect(out.log).toEqual(['ECHO: "hello drawer"']);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain("undefined_thing");
    const view = decode(await readFile(join(out.dir, "iso.png")));
    expect([view.width, view.height]).toEqual([400, 400]);
    const sheet = decode(await readFile(join(out.dir, "sheet.png")));
    expect([sheet.width, sheet.height]).toEqual([801, 801]);

    const again = await renderer.render({ file, searchPaths: [project, library], views: [...ALL], size: 400 });
    expect(again.cached).toBe(true);
    expect(again.key).toBe(out.key);
    expect(again.log).toEqual(out.log);
    expect(again.info).toEqual(out.info);
  }, SLOW);

  test("ASCII STL renders through the import wrapper and is stored as binary STL", async () => {
    const file = join(project, "refs", "cube.stl");
    await mkdir(join(project, "refs"), { recursive: true });
    await writeFile(file, cubeAsciiStl());
    const out = await renderer.render({ file, searchPaths: [project, library], views: ["iso", "top"], size: 300 });
    expect(out.views).toEqual(["iso", "top"]);
    expect(out.info.format).toBe("stl");
    expect(out.info.volumeCm3).toBeCloseTo(1, 6);
    expect(isBinaryStl(new Uint8Array(await readFile(join(out.dir, "mesh.stl"))))).toBe(true);
    expect(await exists(join(out.dir, "front.png"))).toBe(false);
    const sheet = decode(await readFile(join(out.dir, "sheet.png")));
    expect([sheet.width, sheet.height]).toEqual([601, 300]);
  }, SLOW);

  test("3MF renders", async () => {
    const file = join(project, "refs", "cube.3mf");
    await mkdir(join(project, "refs"), { recursive: true });
    await writeFile(file, cube3mf());
    const out = await renderer.render({ file, searchPaths: [], views: ["iso"], size: 200 });
    expect(out.info.format).toBe("3mf");
    expect(out.info.bbox.min).toEqual([10, 20, 30]);
    expect(await exists(join(out.dir, "iso.png"))).toBe(true);
  }, SLOW);

  test("use <…> resolves through searchPaths and the library file is part of the key", async () => {
    const lib = join(library, "parts", "pegs.scad");
    await writeFile(lib, "module peg(h) { cylinder(h = h, d = 4, $fn = 24); }\n");
    const file = join(project, "src", "board.scad");
    await writeFile(file, "use <parts/pegs.scad>\ncube([30, 20, 2]);\nfor (x = [5, 25]) translate([x, 10, 2]) peg(6);\n");
    const req = { file, searchPaths: [project, library], views: ["iso" as const, "front" as const], size: 400 };
    const first = await renderer.render(req);
    expect(first.warnings).toEqual([]);
    expect(first.info.bbox.size[2]).toBeCloseTo(8, 3);
    await writeFile(lib, "module peg(h) { cylinder(h = h * 2, d = 4, $fn = 24); }\n");
    const second = await renderer.render(req);
    expect(second.cached).toBe(false);
    expect(second.key).not.toBe(first.key);
    expect(second.info.bbox.size[2]).toBeCloseTo(14, 3);
  }, SLOW);

  test("a broken SCAD file throws RenderError with OpenSCAD's message", async () => {
    const file = join(project, "src", "broken.scad");
    await writeFile(file, "cube(10)\nsphere(;\n");
    const err = await renderer.render({ file, searchPaths: [project], views: ["iso"], size: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as Error).message).toContain("Parser error");
    expect((err as Error).message).toContain("broken.scad, line 2");
  }, SLOW);

  test("a 2D-only SCAD file throws RenderError", async () => {
    const file = join(project, "src", "flat.scad");
    await writeFile(file, "square(10);\n");
    await expect(renderer.render({ file, searchPaths: [project], views: ["top"], size: 200 })).rejects.toThrow("not a 3D object");
  }, SLOW);

  test("check: ok, warnings and errors with file and line, without building geometry", async () => {
    const good = join(project, "src", "check-good.scad");
    await writeFile(good, 'echo("checked");\nx = undefined_thing;\ncube(10);\n');
    const ok = await renderer.check({ file: good, searchPaths: [project, library] });
    expect(ok.ok).toBe(true);
    expect(ok.log).toEqual(['ECHO: "checked"']);
    expect(ok.diagnostics.length).toBe(1);
    expect(ok.diagnostics[0]).toMatchObject({ level: "warning", file: good, line: 2 });
    expect(ok.diagnostics[0]?.message).toContain("undefined_thing");

    const bad = join(project, "src", "check-bad.scad");
    await writeFile(bad, "cube(10)\nsphere(;\n");
    const broken = await renderer.check({ file: bad, searchPaths: [project] });
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.find((d) => d.level === "error")).toMatchObject({ file: bad, line: 2 });

    const asserted = join(project, "src", "check-assert.scad");
    await writeFile(asserted, "w = 5;\nassert(w > 10, \"too thin\");\ncube(w);\n");
    expect((await renderer.check({ file: asserted, searchPaths: [project] })).ok).toBe(false);
    expect((await renderer.check({ file: asserted, searchPaths: [project], params: { w: 20 } })).ok).toBe(true);
  }, SLOW);

  test("params become -D overrides and part of the key", async () => {
    const file = join(project, "src", "param.scad");
    await writeFile(file, "w = 10; // [5:50]\nlabel = \"x\";\ncube([w, 10, 10]);\n");
    const plain = await renderer.render({ file, searchPaths: [project], views: ["top"], size: 200 });
    const wide = await renderer.render({ file, searchPaths: [project], views: ["top"], size: 200, params: { w: 20, label: 'a "quoted" one' } });
    expect(plain.info.bbox.size[0]).toBeCloseTo(10, 4);
    expect(wide.info.bbox.size[0]).toBeCloseTo(20, 4);
    expect(wide.key).not.toBe(plain.key);
    expect((await renderer.render({ file, searchPaths: [project], views: ["top"], size: 200, params: { label: 'a "quoted" one', w: 20 } })).cached).toBe(true);
  }, SLOW);

  test("section, interference and an assembly on real renders", async () => {
    const file = join(project, "src", "block.scad");
    await writeFile(file, "difference() { cube(10); translate([5, 5, -1]) cylinder(h = 12, d = 4, $fn = 48); }\n");
    const out = await renderer.render({ file, searchPaths: [project], views: ["iso"], size: 200 });

    const name = await renderer.section({ key: out.key, axis: "z", at: 5, size: 200 });
    expect(name).toBe("section-z-5-200.png");
    expect(name).toMatch(/^[a-z0-9._-]+$/);
    const png = decode(await readFile(join(out.dir, name)));
    expect([png.width, png.height]).toEqual([200, 200]);
    expect(await renderer.section({ key: out.key, axis: "x", at: 2.5, size: 120 })).toBe("section-x-2.5-120.png");
    await expect(renderer.section({ key: out.key, axis: "z", at: 50, size: 200 })).rejects.toBeInstanceOf(RenderError);

    const hole = (await renderer.slice({ key: out.key, axis: "z", at: 5 })).contours.find((c) => c.hole);
    expect(hole?.circle.round).toBe(true);
    expect(Math.abs((hole?.circle.diameter ?? 0) - 4)).toBeLessThan(0.02);

    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const shifted = [1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const apart = [1, 0, 0, 12.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const overlap = await renderer.interference({ a: { key: out.key, matrix: I }, b: { key: out.key, matrix: shifted } });
    expect(overlap.gapMm).toBe(0);
    // A 3 × 10 × 10 slab, minus the parts of both holes inside it (none: they sit at x = 3..7 and 10..14).
    expect(overlap.overlapCm3).toBeCloseTo(0.3, 3);
    expect(await renderer.interference({ a: { key: out.key, matrix: I }, b: { key: out.key, matrix: apart } })).toEqual({ gapMm: 2.5, overlapCm3: 0 });

    const asm = await renderer.renderAssembly({
      instances: [
        { id: "left", key: out.key, matrix: I },
        { id: "right", key: out.key, matrix: shifted },
      ],
      highlight: ["right"],
      views: ["iso", "top"],
      size: 200,
    });
    expect(asm.cached).toBe(false);
    expect(asm.dir).toBe(join(root, "cache", asm.key));
    for (const f of ["iso.png", "top.png", "sheet.png"]) expect(await exists(join(asm.dir, f))).toBe(true);
    const again = await renderer.renderAssembly({ instances: [{ id: "left", key: out.key, matrix: I }, { id: "right", key: out.key, matrix: shifted }], highlight: ["right"], views: ["iso", "top"], size: 200 });
    expect(again).toEqual({ ...asm, cached: true });
  }, SLOW);
});
