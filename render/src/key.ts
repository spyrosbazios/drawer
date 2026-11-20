/**
 * The render cache key: SHA-256 over every input that changes the output.
 * Each part is length-prefixed so adjacent parts cannot run into each other.
 */
import { createHash } from "node:crypto";
import type { RenderView } from "@drawer/shared/api";

/** Bump when the pipeline itself changes what it writes (colours, sheet layout, file set) or what a cached measurement beside the render means. */
export const PIPELINE_VERSION = "drawer-render/3";

export interface KeyInputs {
  /** Bytes of the file being rendered. */
  file: Uint8Array;
  /** Bytes of each dependency OpenSCAD reported, in a stable (path-sorted) order. */
  deps: Uint8Array[];
  views: RenderView[];
  size: number;
  openscadVersion: string;
  /** The `-D` arguments, in their stable (name-sorted) order. */
  defines: string[];
}

export function cacheKey(inputs: KeyInputs): string {
  return hashParts([
    PIPELINE_VERSION,
    inputs.openscadVersion,
    inputs.views.join(","),
    String(inputs.size),
    inputs.defines.join("\n"),
    inputs.file,
    String(inputs.deps.length),
    ...inputs.deps,
  ]);
}

/** SHA-256 hex over length-prefixed parts. */
export function hashParts(parts: (Uint8Array | string)[]): string {
  const hash = createHash("sha256");
  for (const bytes of parts) {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const len = new Uint8Array(8);
    new DataView(len.buffer).setBigUint64(0, BigInt(data.byteLength));
    hash.update(len);
    hash.update(data);
  }
  return hash.digest("hex");
}
