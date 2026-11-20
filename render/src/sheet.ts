/**
 * Contact sheet: the requested views in a grid, each with a small label in its top-left corner.
 * Pure JS (fast-png); the labels use a built-in 5×7 bitmap font so no font files are needed.
 */
import { decode, encode } from "fast-png";
import type { RenderView } from "@drawer/shared/api";

type Rgb = readonly [number, number, number];

/** Matches the background of OpenSCAD's "Nord Light" scheme, so gaps blend with the views. */
const SHEET_BACKGROUND: Rgb = [0xe5, 0xe9, 0xf0];
const GRID_LINE: Rgb = [0xc4, 0xcb, 0xd6];
const LABEL_FILL: Rgb = [0x2e, 0x34, 0x40];
const LABEL_TEXT: Rgb = [0xec, 0xef, 0xf4];

const LABELS: Record<RenderView, string> = { iso: "ISO", front: "FRONT", top: "TOP", side: "SIDE" };

const GLYPH_W = 5;
const GLYPH_H = 7;
/** Rows of 5 bits, top to bottom; only the letters the labels use. */
const GLYPHS: Record<string, readonly string[]> = {
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
};

export interface SheetCell {
  view: RenderView;
  png: Uint8Array;
}

/** Columns × rows for n views: 1 → 1×1, 2 → 2×1, 3–4 → 2×2. */
export function gridFor(n: number): { cols: number; rows: number } {
  const cols = n <= 1 ? 1 : 2;
  return { cols, rows: Math.ceil(n / cols) };
}

export function composeSheet(cells: SheetCell[], size: number): Uint8Array {
  const { cols, rows } = gridFor(cells.length);
  const gap = Math.max(1, Math.round(size / 400));
  const width = cols * size + (cols - 1) * gap;
  const height = rows * size + (rows - 1) * gap;
  const canvas = new Uint8Array(width * height * 3);
  fill(canvas, width, 0, 0, width, height, GRID_LINE);
  const scale = Math.max(2, Math.round(size / 266));
  cells.forEach((cell, i) => {
    const x0 = (i % cols) * (size + gap);
    const y0 = Math.floor(i / cols) * (size + gap);
    fill(canvas, width, x0, y0, size, size, SHEET_BACKGROUND);
    blit(canvas, width, x0, y0, size, cell.png);
    drawLabel(canvas, width, x0 + 4 * scale, y0 + 4 * scale, LABELS[cell.view], scale);
  });
  return encode({ width, height, data: canvas, channels: 3, depth: 8 });
}

function blit(canvas: Uint8Array, canvasWidth: number, x0: number, y0: number, size: number, png: Uint8Array): void {
  const img = decode(png);
  if (img.depth !== 8 || img.palette) throw new Error(`unexpected PNG format from OpenSCAD (depth ${img.depth})`);
  const ch = img.channels;
  const w = Math.min(img.width, size);
  const h = Math.min(img.height, size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * img.width + x) * ch;
      const d = ((y0 + y) * canvasWidth + x0 + x) * 3;
      const gray = ch < 3;
      const a = ch === 4 || ch === 2 ? (img.data[s + ch - 1] ?? 255) / 255 : 1;
      for (let k = 0; k < 3; k++) {
        const src = img.data[gray ? s : s + k] ?? 0;
        canvas[d + k] = Math.round(src * a + (canvas[d + k] ?? 0) * (1 - a));
      }
    }
  }
}

function drawLabel(canvas: Uint8Array, canvasWidth: number, x: number, y: number, text: string, scale: number): void {
  const pad = 2 * scale;
  const advance = (GLYPH_W + 1) * scale;
  const w = text.length * advance - scale + pad * 2;
  const h = GLYPH_H * scale + pad * 2;
  fill(canvas, canvasWidth, x, y, w, h, LABEL_FILL);
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`no glyph for "${ch}"`);
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (row[gx] === "#") fill(canvas, canvasWidth, x + pad + i * advance + gx * scale, y + pad + gy * scale, scale, scale, LABEL_TEXT);
      }
    });
  });
}

function fill(canvas: Uint8Array, canvasWidth: number, x0: number, y0: number, w: number, h: number, rgb: Rgb): void {
  const height = canvas.length / 3 / canvasWidth;
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(canvasWidth, x0 + w); x++) {
      const d = (y * canvasWidth + x) * 3;
      canvas[d] = rgb[0];
      canvas[d + 1] = rgb[1];
      canvas[d + 2] = rgb[2];
    }
  }
}
