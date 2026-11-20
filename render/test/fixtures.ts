/** Tiny test meshes, generated in code: a 10 mm unit cube (1 cm³) in every format. */
import { strToU8, zipSync } from "fflate";

/** Cube corners, indexed 0..7 as (x, y, z) bits. */
const CORNERS: [number, number, number][] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [(i & 1) * 10, ((i >> 1) & 1) * 10, ((i >> 2) & 1) * 10]);

/** Outward-facing quads (counter-clockwise seen from outside). */
const QUADS: [number, number, number, number][] = [
  [0, 2, 3, 1], // z = 0
  [4, 5, 7, 6], // z = 10
  [0, 1, 5, 4], // y = 0
  [2, 6, 7, 3], // y = 10
  [0, 4, 6, 2], // x = 0
  [1, 3, 7, 5], // x = 10
];

export function cubeTriangles(dropFaces = 0): [number, number, number][] {
  const tris: [number, number, number][] = [];
  for (const [a, b, c, d] of QUADS.slice(0, QUADS.length - dropFaces)) {
    tris.push([a, b, c], [a, c, d]);
  }
  return tris;
}

export function cubeAsciiStl(): Uint8Array {
  const lines = ["solid cube"];
  for (const tri of cubeTriangles()) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (const v of tri) lines.push(`      vertex ${CORNERS[v]!.join(" ")}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid cube");
  return strToU8(lines.join("\n"));
}

export function cubeBinaryStl(dropFaces = 0): Uint8Array {
  const tris = cubeTriangles(dropFaces);
  const out = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(out.buffer);
  out.set(strToU8("solid this header starts with solid but the file is binary"));
  view.setUint32(80, tris.length, true);
  tris.forEach((tri, t) => {
    tri.forEach((v, k) => {
      CORNERS[v]!.forEach((c, axis) => view.setFloat32(84 + t * 50 + 12 + k * 12 + axis * 4, c, true));
    });
  });
  return out;
}

export function cubeObj(): Uint8Array {
  const lines = ["# cube", "o cube"];
  for (const c of CORNERS) lines.push(`v ${c.join(" ")}`);
  lines.push("vn 0 0 1");
  // Quads, mixing plain, v//vn and negative indices.
  QUADS.forEach(([a, b, c, d], i) => {
    if (i === 0) lines.push(`f ${a + 1}//1 ${b + 1}//1 ${c + 1}//1 ${d + 1}//1`);
    else if (i === 1) lines.push(`f ${a - 8} ${b - 8} ${c - 8} ${d - 8}`);
    else lines.push(`f ${a + 1} ${b + 1} ${c + 1} ${d + 1}`);
  });
  return strToU8(lines.join("\n"));
}

/**
 * A 3MF whose cube lives in a second model part (production extension, as Bambu/Prusa write
 * them), referenced through a component and placed by a translated build item, in centimetres.
 */
export function cube3mf(): Uint8Array {
  const verts = CORNERS.map((c) => `<vertex x="${c[0] / 10}" y="${c[1] / 10}" z="${c[2] / 10}"/>`).join("");
  const tris = cubeTriangles()
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    .join("");
  const ns = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
  const part = `<?xml version="1.0" encoding="UTF-8"?><model unit="centimeter" ${ns}><resources><object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object></resources><build/></model>`;
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="centimeter" xml:lang="en-US" ${ns}>
  <resources>
    <object id="2" type="model">
      <components><component p:path="/3D/Objects/cube.model" objectid="1"/></components>
    </object>
  </resources>
  <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 1 2 3"/></build>
</model>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(root),
    "3D/Objects/cube.model": strToU8(part),
  });
}
