import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshInfo } from "@drawer/shared/api";
import { strToU8, zipSync } from "fflate";
import { MAX_3MF_ENTRIES, MAX_3MF_ENTRY_BYTES, MAX_3MF_TOTAL_BYTES, computeMeshInfo, isBinaryStl, meshInfoOf, parseMesh, parseStl, toBinaryStl } from "../src/mesh";
import { cube3mf, cubeAsciiStl, cubeBinaryStl, cubeObj } from "./fixtures";

function expectUnitCube(info: MeshInfo, offset: [number, number, number] = [0, 0, 0]): void {
  expect(info.triangles).toBe(12);
  expect(info.bbox.size).toEqual([10, 10, 10]);
  expect(info.bbox.min).toEqual(offset);
  expect(info.bbox.max).toEqual([offset[0] + 10, offset[1] + 10, offset[2] + 10]);
  expect(info.volumeCm3).toBeCloseTo(1, 6);
}

describe("meshInfo", () => {
  test("binary STL (header starting with 'solid')", () => {
    const bytes = cubeBinaryStl();
    expect(isBinaryStl(bytes)).toBe(true);
    const info = computeMeshInfo(parseMesh("stl", bytes));
    expect(info.format).toBe("stl");
    expectUnitCube(info);
  });

  test("ASCII STL", () => {
    expect(isBinaryStl(cubeAsciiStl())).toBe(false);
    expectUnitCube(computeMeshInfo(parseMesh("stl", cubeAsciiStl())));
  });

  test("OBJ with quads, v//vn and negative indices", () => {
    const info = computeMeshInfo(parseMesh("obj", cubeObj()));
    expect(info.format).toBe("obj");
    expectUnitCube(info);
  });

  test("3MF with a component in a second part, cm units and a build transform", () => {
    const info = computeMeshInfo(parseMesh("3mf", cube3mf()));
    expect(info.format).toBe("3mf");
    // translation 1,2,3 cm → 10,20,30 mm
    expectUnitCube(info, [10, 20, 30]);
  });

  test("open mesh has no volume", () => {
    const info = computeMeshInfo(parseMesh("stl", cubeBinaryStl(1)));
    expect(info.triangles).toBe(10);
    expect(info.bbox.size).toEqual([10, 10, 10]);
    expect(info.volumeCm3).toBeNull();
  });

  test("flat mesh has no volume", () => {
    const flat = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 0, 0, 10, 0, 10, 0, 0]);
    expect(computeMeshInfo({ format: "stl", positions: flat }).volumeCm3).toBeNull();
  });

  test("toBinaryStl round-trips", () => {
    const positions = parseStl(cubeAsciiStl());
    const bin = toBinaryStl(positions);
    expect(isBinaryStl(bin)).toBe(true);
    expect(parseStl(bin)).toEqual(positions);
  });

  test("reads from disk by extension and rejects junk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawer-mesh-"));
    await writeFile(join(dir, "c.obj"), cubeObj());
    await writeFile(join(dir, "c.3mf"), cube3mf());
    await writeFile(join(dir, "junk.stl"), "not a mesh");
    expectUnitCube(await meshInfoOf(join(dir, "c.obj")));
    expect((await meshInfoOf(join(dir, "c.3mf"))).format).toBe("3mf");
    await expect(meshInfoOf(join(dir, "junk.stl"))).rejects.toThrow();
    await expect(meshInfoOf(join(dir, "missing.stl"))).rejects.toThrow();
  });
});

describe("3MF size limits", () => {
  const rels = strToU8('<Relationships><Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');

  /**
   * A zip of `_rels/.rels` and a model part that inflates to `bytes` zeros, deflated natively (fast) and
   * wrapped by hand. Header sizes are `claimed` when given: the reader must not believe them.
   */
  function zeroBomb(bytes: number, claimed?: number): Uint8Array {
    const entries = [
      { name: "_rels/.rels", data: Bun.deflateSync(rels), size: rels.length },
      { name: "3D/3dmodel.model", data: Bun.deflateSync(new Uint8Array(bytes), { level: 9 }), size: bytes },
    ];
    const local: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const e of entries) {
      const name = strToU8(e.name);
      const size = claimed ?? e.size;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(8, 8, true);
      lh.setUint32(18, e.data.length, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(10, 8, true);
      ch.setUint32(20, e.data.length, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      local.push(new Uint8Array(lh.buffer), name, e.data);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + e.data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const parts = [...local, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  test("the hand-made archive is read as a 3MF container", () => {
    // Zeros are not XML, so the model has no objects, but nothing about the archive is refused.
    expect(parseMesh("3mf", zeroBomb(16)).positions.length).toBe(0);
  });

  test("the caps are named and fit real files", () => {
    expect(MAX_3MF_ENTRY_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_3MF_TOTAL_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_3MF_ENTRIES).toBe(1000);
  });

  test("a small archive that inflates past the per-part cap is refused, even when its headers claim a small size", () => {
    const size = MAX_3MF_ENTRY_BYTES + 1024 * 1024;
    const honest = zeroBomb(size);
    expect(honest.length).toBeLessThan(1024 * 1024);
    expect(() => parseMesh("3mf", honest)).toThrow("inflates to more than 256 MB");
    expect(() => parseMesh("3mf", zeroBomb(size, 1000))).toThrow("inflates to more than 256 MB");
  }, 60_000);

  test("an archive with too many model parts is refused", () => {
    const files: Record<string, Uint8Array> = { "_rels/.rels": rels };
    for (let i = 0; i < MAX_3MF_ENTRIES; i++) files[`3D/part${i}.model`] = strToU8("<model/>");
    expect(() => parseMesh("3mf", zipSync(files))).toThrow(`more than ${MAX_3MF_ENTRIES} model parts`);
  });
});
