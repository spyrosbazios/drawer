/** PLY 1.0 ASCII and binary. Unused element properties are consumed in the declared order. */
type Scalar = "char" | "uchar" | "short" | "ushort" | "int" | "uint" | "float" | "double";
const TYPES: Record<string, Scalar> = {
  char: "char",
  int8: "char",
  uchar: "uchar",
  uint8: "uchar",
  short: "short",
  int16: "short",
  ushort: "ushort",
  uint16: "ushort",
  int: "int",
  int32: "int",
  uint: "uint",
  uint32: "uint",
  float: "float",
  float32: "float",
  double: "double",
  float64: "double",
};
interface Property {
  name: string;
  type: Scalar;
  countType?: Scalar;
}
interface Element {
  name: string;
  count: number;
  properties: Property[];
}

function scalar(name: string | undefined): Scalar {
  const type = name === undefined || !Object.hasOwn(TYPES, name) ? undefined : TYPES[name];
  if (!type) throw new Error(`unsupported PLY property type: ${name}`);
  return type;
}

function binaryReader(bytes: Uint8Array, start: number, little: boolean): (type: Scalar) => number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  return (type) => {
    switch (type) {
      case "char":
        return view.getInt8(offset++);
      case "uchar":
        return view.getUint8(offset++);
      case "short":
        offset += 2;
        return view.getInt16(offset - 2, little);
      case "ushort":
        offset += 2;
        return view.getUint16(offset - 2, little);
      case "int":
        offset += 4;
        return view.getInt32(offset - 4, little);
      case "uint":
        offset += 4;
        return view.getUint32(offset - 4, little);
      case "float":
        offset += 4;
        return view.getFloat32(offset - 4, little);
      case "double":
        offset += 8;
        return view.getFloat64(offset - 8, little);
    }
  };
}

export function parsePly(bytes: Uint8Array, limit: number): Float32Array {
  const decoder = new TextDecoder();
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 65_536)).toString("latin1");
  const terminator = /^end_header\r?\n/m.exec(header);
  if (!terminator) throw new Error("PLY header is missing end_header");
  const bodyStart = terminator.index + terminator[0].length;
  const lines = header.slice(0, terminator.index).trimEnd().split(/\r?\n/);
  const format = /^format (ascii|binary_little_endian|binary_big_endian) 1\.0$/.exec(lines[1] ?? "")?.[1];
  if (lines[0] !== "ply" || !format) throw new Error("expected a PLY 1.0 header");
  const elements: Element[] = [];
  for (const line of lines.slice(2)) {
    const [command, a, b, c, d] = line.trim().split(/\s+/);
    if (command === "element") {
      const count = Number(b);
      if (!a || !Number.isSafeInteger(count) || count < 0 || count > bytes.length) throw new Error("invalid PLY element count");
      if (elements.some((element) => element.name === a)) throw new Error(`duplicate PLY element ${a}`);
      elements.push({ name: a, count, properties: [] });
    } else if (command === "property") {
      const element = elements.at(-1);
      if (!element || !a || !b) throw new Error("invalid PLY property");
      if (a === "list") {
        if (!d) throw new Error("invalid PLY list property");
        const countType = scalar(b);
        if (countType === "float" || countType === "double") throw new Error("PLY list counts must be integers");
        element.properties.push({ name: d, type: scalar(c), countType });
      } else {
        element.properties.push({ name: b, type: scalar(a) });
      }
    }
  }
  const vert = elements.find((element) => element.name === "vertex");
  const face = elements.find((element) => element.name === "face");
  if (!vert || !["x", "y", "z"].every((axis) => vert.properties.some((prop) => prop.name === axis && !prop.countType))) throw new Error("PLY has no XYZ vertices");
  if (!face?.count) throw new Error("point cloud has no faces; export a triangulated surface");
  if (face.count > limit || vert.count > limit * 3) throw new Error(`mesh exceeds ${limit} triangles; decimate before uploading`);
  if (elements.indexOf(vert) > elements.indexOf(face)) throw new Error("PLY vertices must precede faces");
  const indices = face.properties.find((prop) => prop.countType && (prop.name === "vertex_indices" || prop.name === "vertex_index"));
  if (!indices) throw new Error("PLY faces have no vertex indices");

  const text = format === "ascii" ? decoder.decode(bytes.subarray(bodyStart)) : null;
  const word = /\S+/g;
  const read =
    text === null
      ? binaryReader(bytes, bodyStart, format === "binary_little_endian")
      : () => {
          const next = word.exec(text);
          if (!next) throw new Error("truncated PLY");
          const value = Number(next[0]);
          if (!Number.isFinite(value)) throw new Error("invalid PLY number");
          return value;
        };
  const verts = new Float64Array(vert.count * 3);
  let triangles = new Float32Array(face.count * 9);
  let used = 0;
  try {
    for (const element of elements) {
      if (element.properties.length === 0) continue;
      for (let row = 0; row < element.count; row++) {
        for (const property of element.properties) {
          if (!property.countType) {
            const value = read(property.type);
            if (element === vert) {
              const axis = ["x", "y", "z"].indexOf(property.name);
              if (axis >= 0) {
                if (!Number.isFinite(value)) throw new Error("non-finite PLY vertex");
                verts[row * 3 + axis] = value;
              }
            }
            continue;
          }
          const count = read(property.countType);
          if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length) throw new Error("invalid PLY list length");
          if (property !== indices) {
            for (let i = 0; i < count; i++) read(property.type);
            continue;
          }
          if (count < 3) throw new Error("PLY face needs at least three vertices");
          const required = used + (count - 2) * 9;
          if (required > limit * 9) throw new Error(`mesh exceeds ${limit} triangles; decimate before uploading`);
          if (required > triangles.length) {
            const grown = new Float32Array(Math.max(required, Math.min(limit * 9, triangles.length * 2)));
            grown.set(triangles);
            triangles = grown;
          }
          const vertex = () => {
            const index = read(property.type);
            if (!Number.isSafeInteger(index) || index < 0 || index >= vert.count) throw new Error("PLY vertex index is out of range");
            return index * 3;
          };
          const first = vertex();
          let previous = vertex();
          for (let i = 2; i < count; i++) {
            const current = vertex();
            for (const corner of [first, previous, current]) {
              for (let axis = 0; axis < 3; axis++) triangles[used++] = verts[corner + axis]!;
            }
            previous = current;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof RangeError) throw new Error("truncated PLY");
    throw err;
  }
  return triangles.subarray(0, used);
}
