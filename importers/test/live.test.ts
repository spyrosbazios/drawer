/**
 * Live network checks. Off by default; run with `DRAWER_LIVE=1 bun test test/live.test.ts`.
 * A handful of polite requests against public models, no credentials.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImporters } from "../src/index";

const live = process.env.DRAWER_LIVE === "1" ? describe : describe.skip;

/** A binary STL is an 80-byte header, a uint32 count and 50 bytes per triangle; an ASCII STL starts with "solid". */
function looksLikeStl(buf: Buffer): boolean {
  if (buf.subarray(0, 5).toString("latin1").toLowerCase() === "solid" && buf.includes("facet")) return true;
  if (buf.length < 84) return false;
  return buf.length === 84 + buf.readUInt32LE(80) * 50;
}

live("live", () => {
  const importers = createImporters({});

  test("Printables: preview and one STL", async () => {
    const url = "https://www.printables.com/model/642560-apple-earpods-earbuds-holder-wrap-usb-c";
    const preview = await importers.preview(url);
    expect(preview.source.site).toBe("printables");
    expect(preview.source.title).toContain("earbuds holder");
    expect(preview.source.license).toBeTruthy();
    expect(preview.source.images.length).toBeGreaterThan(0);
    expect(preview.blocker).toBeNull();
    const stl = preview.files.find((f) => f.name.endsWith(".stl"));
    expect(stl).toBeDefined();

    const dir = await mkdtemp(join(tmpdir(), "drawer-live-"));
    try {
      const dest = join(dir, "nested", "model.stl");
      await importers.download(url, stl!, dest);
      const buf = await readFile(dest);
      expect(looksLikeStl(buf)).toBe(true);
      expect((await stat(dest)).size).toBe(stl!.size!);

      const img = join(dir, "img", "first.jpg");
      await importers.downloadImage(preview.source.images[0]!, img);
      expect((await stat(img)).size).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("MakerWorld: anonymous metadata, files blocked without a token", async () => {
    const preview = await importers.preview("https://makerworld.com/en/models/1054000-remote-control-cover");
    expect(preview.source.site).toBe("makerworld");
    expect(preview.source.title).toBe("Remote control cover");
    expect(preview.source.author).toBeTruthy();
    expect(preview.source.license).toBeTruthy();
    expect(preview.source.images.length).toBeGreaterThan(0);
    expect(preview.files.length).toBeGreaterThan(0);
    expect(preview.files.every((f) => !f.downloadable && f.name.endsWith(".3mf"))).toBe(true);
    expect(preview.blocker).toContain("MAKERWORLD_TOKEN");
  }, 60_000);

  test("MakerWorld: unknown model is an ImportError", async () => {
    await expect(importers.preview("https://makerworld.com/en/models/999999999999")).rejects.toThrow("no such model");
  }, 60_000);

  test("generic: a plain page", async () => {
    const preview = await importers.preview("https://example.com/");
    expect(preview.source.site).toBe("generic");
    expect(preview.source.title).toBe("Example Domain");
    expect(preview.files).toEqual([]);
  }, 60_000);
});
