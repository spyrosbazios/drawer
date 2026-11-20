/** Downscaling a rendered view for a thumbnail: an area average, so thin edges fade instead of breaking up. Pure JS (fast-png). */
import { decode, encode } from "fast-png";

/** `png` scaled so its longer side is at most `size` pixels; returned unchanged when it is already that small. */
export function scaleDown(png: Uint8Array, size: number): Uint8Array {
  const img = decode(png);
  if (img.depth !== 8 || img.palette) throw new Error(`unexpected PNG format (depth ${img.depth})`);
  const scale = size / Math.max(img.width, img.height);
  if (scale >= 1) return png;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const ch = img.channels;
  const out = new Uint8Array(width * height * ch);
  const sums = new Float64Array(ch);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * img.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * img.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / width));
      sums.fill(0);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * img.width + sx) * ch;
          for (let k = 0; k < ch; k++) sums[k] = (sums[k] ?? 0) + (img.data[s + k] ?? 0);
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const d = (y * width + x) * ch;
      for (let k = 0; k < ch; k++) out[d + k] = Math.round((sums[k] ?? 0) / n);
    }
  }
  return encode({ width, height, data: out, channels: ch, depth: 8 });
}
