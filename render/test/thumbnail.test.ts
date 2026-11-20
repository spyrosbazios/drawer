import { describe, expect, test } from "bun:test";
import { decode, encode } from "fast-png";
import { scaleDown } from "../src/thumbnail";

/** A width × height RGB image: left half black, right half white. */
function halves(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = width / 2; x < width; x++) data.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
  return encode({ width, height, data, channels: 3, depth: 8 });
}

describe("scaleDown", () => {
  test("scales the longer side to the size and averages the area", () => {
    const out = decode(scaleDown(halves(800, 400), 200));
    expect([out.width, out.height, out.channels]).toEqual([200, 100, 3]);
    expect(out.data[0]).toBe(0);
    expect(out.data[(50 * 200 + 199) * 3]).toBe(255);
  });

  test("a pixel straddling the edge gets the mean", () => {
    const out = decode(scaleDown(halves(6, 6), 2));
    expect(out.width).toBe(2);
    expect([out.data[0], out.data[3]]).toEqual([0, 255]);
    const odd = decode(scaleDown(halves(4, 4), 1));
    expect(odd.data[0]).toBe(128);
  });

  test("an image already small enough comes back as it was", () => {
    const png = halves(100, 100);
    expect(scaleDown(png, 200)).toBe(png);
  });
});
