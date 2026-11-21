import { expect, test } from "bun:test";
import { parseMesh, parseStl, toBinaryStl } from "../src/mesh";
import { clusterProxy, normalizeScan } from "../src/scan";
import { volume } from "../src/measure";
import { cube3mf, cubeBinaryStl } from "./fixtures";

const plyHeader = (mode: string) => `ply
format ${mode} 1.0
comment Scán
element vertex 4
property float x
property float y
property float z
property uchar red
element face 1
property list uchar int vertex_indices
end_header
`;

test("reads PLY polygons and skips scalar colours in ASCII and big-endian binary", () => {
  const enc = new TextEncoder();
  const ascii = enc.encode(plyHeader("ascii") + "0 0 0 10\n1 0 0 20\n1 1 0 30\n0 1 0 40\n4 0 1 2 3\n");
  const header = enc.encode(plyHeader("binary_big_endian"));
  const binary = new Uint8Array(header.length + 4 * 13 + 17);
  binary.set(header);
  const view = new DataView(binary.buffer, header.length);
  view.setFloat32(13, 1);
  view.setFloat32(26, 1);
  view.setFloat32(30, 1);
  view.setFloat32(43, 1);
  view.setUint8(52, 4);
  for (let i = 0; i < 4; i++) view.setInt32(53 + i * 4, i);
  const expected = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  expect(parseMesh("ply", ascii).positions).toEqual(expected);
  expect(parseMesh("ply", binary).positions).toEqual(expected);
  expect(() => parseMesh("ply", binary.subarray(0, -1))).toThrow("truncated PLY");
  expect(() => parseMesh("ply", ascii, 1)).toThrow("decimate");
  const pointCloud = enc.encode(plyHeader("ascii").replace("element face 1", "element face 0"));
  expect(() => normalizeScan("ply", pointCloud, "mm")).toThrow("point cloud");
});

test("normalizes STL units, welds a seam, filters triangles and orients a closed scan", () => {
  const cube = parseStl(cubeBinaryStl());
  const reversed = new Float32Array(cube.length + 18);
  for (let t = 0; t < cube.length; t += 9) {
    reversed.set(cube.subarray(t, t + 3), t);
    reversed.set(cube.subarray(t + 6, t + 9), t + 3);
    reversed.set(cube.subarray(t + 3, t + 6), t + 6);
  }
  reversed[0]! += 0.00001;
  reversed.set([50, 50, 0, 51, 50, 0, 50, 51, 0, 33, 0, 0, 34, 0, 0, 35, 0, 0], cube.length);
  const result = normalizeScan("stl", toBinaryStl(reversed), "cm");
  expect(result.originalTriangles).toBe(14);
  expect(result.degenerateTriangles).toBe(1);
  expect(result.debrisTriangles).toBe(1);
  expect(result.info).toMatchObject({ triangles: 12, closed: true, bbox: { size: [100, 100, 100] } });
  expect(Math.abs((result.info.volumeCm3 ?? 0) - 1000)).toBeLessThan(0.001);
  expect(Math.abs(volume(parseStl(result.bytes)) - 1_000_000)).toBeLessThan(1);
  expect(() => parseMesh("stl", cubeBinaryStl(), 1)).toThrow("decimate");
});

test("3MF's embedded units take precedence and open scans have no volume", () => {
  const embedded = normalizeScan("3mf", cube3mf(), "in");
  expect(embedded.unit).toBe("centimeter");
  expect(embedded.info.bbox).toMatchObject({ min: [10, 20, 30], size: [10, 10, 10] });
  const open = normalizeScan("stl", cubeBinaryStl(1), "mm");
  expect(open.info).toMatchObject({ triangles: 10, closed: false, volumeCm3: null });
  expect(open.noiseMm).toBeGreaterThanOrEqual(0);
});

test("the vertex-clustered preview stays within the triangle budget", () => {
  const grid = new Float32Array(9 * 2 * 20 * 20);
  let cursor = 0;
  for (let x = 0; x < 20; x++)
    for (let y = 0; y < 20; y++) {
      grid.set([x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y, 0, x + 1, y + 1, 0, x, y + 1, 0], cursor);
      cursor += 18;
    }
  const proxy = clusterProxy(grid, 50);
  expect(proxy.length / 9).toBeGreaterThan(0);
  expect(proxy.length / 9).toBeLessThanOrEqual(50);
});
