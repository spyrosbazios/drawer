import { describe, expect, test } from "bun:test";
import { cacheKey } from "../src/key";
import { parseDepsFile, parseStderr } from "../src/process";
import { SerialQueue } from "../src/queue";
import { gridFor } from "../src/sheet";

describe("cacheKey", () => {
  const base = {
    file: new TextEncoder().encode("cube(10);"),
    deps: [new TextEncoder().encode("module m() {}")],
    views: ["iso", "front"] as ("iso" | "front")[],
    size: 800,
    openscadVersion: "2026.11.16",
    defines: ["-D", "w=10"],
  };

  test("is stable for equal inputs", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base, file: new TextEncoder().encode("cube(10);") }));
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes with every input", () => {
    const k = cacheKey(base);
    expect(cacheKey({ ...base, file: new TextEncoder().encode("cube(11);") })).not.toBe(k);
    expect(cacheKey({ ...base, deps: [new TextEncoder().encode("module n() {}")] })).not.toBe(k);
    expect(cacheKey({ ...base, deps: [] })).not.toBe(k);
    expect(cacheKey({ ...base, views: ["front", "iso"] })).not.toBe(k);
    expect(cacheKey({ ...base, size: 400 })).not.toBe(k);
    expect(cacheKey({ ...base, openscadVersion: "2026.11.17" })).not.toBe(k);
    expect(cacheKey({ ...base, defines: ["-D", "w=11"] })).not.toBe(k);
    expect(cacheKey({ ...base, defines: [] })).not.toBe(k);
  });

  test("parts cannot run into each other", () => {
    const a = cacheKey({ ...base, file: new TextEncoder().encode("ab"), deps: [new TextEncoder().encode("c")] });
    const b = cacheKey({ ...base, file: new TextEncoder().encode("a"), deps: [new TextEncoder().encode("bc")] });
    expect(a).not.toBe(b);
  });
});

describe("SerialQueue", () => {
  test("runs one task at a time, in order, and survives failures", async () => {
    const q = new SerialQueue();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const task = (n: number, fail = false) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(5 * (5 - n));
      order.push(n);
      running--;
      if (fail) throw new Error(`task ${n}`);
      return n;
    };
    const results = await Promise.allSettled([q.run(task(1)), q.run(task(2, true)), q.run(task(3)), q.run(task(4))]);
    expect(maxRunning).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  });
});

describe("parseStderr", () => {
  test("splits ECHO lines from warnings and drops the rest", () => {
    const stderr = [
      'ECHO: "hi"',
      'WARNING: Ignoring unknown variable "y" in file w.scad, line 2',
      "TRACE: called by 'echo' in file w.scad, line 2",
      "DEPRECATED: The assign() module will be removed in future releases.",
      'ERROR: Assertion \'false\' failed: "boom" in file w.scad, line 5',
      "Geometries in cache: 3",
      "Total rendering time: 0:00:00.000",
      "ECHO: x = 1",
      "",
    ].join("\n");
    expect(parseStderr(stderr)).toEqual({
      log: ['ECHO: "hi"', "ECHO: x = 1"],
      warnings: [
        'WARNING: Ignoring unknown variable "y" in file w.scad, line 2',
        "DEPRECATED: The assign() module will be removed in future releases.",
        'ERROR: Assertion \'false\' failed: "boom" in file w.scad, line 5',
      ],
    });
  });
});

describe("parseDepsFile", () => {
  test("reads make-style continuation lines and escaped spaces", () => {
    const text = "/tmp/x/deps.echo: \\\n\t/w/c.stl \\\n\t/w/my\\ lib/libmod.scad \\\n\tu.scad\n";
    expect(parseDepsFile(text)).toEqual(["/w/c.stl", "/w/my lib/libmod.scad", "u.scad"]);
  });
});

describe("gridFor", () => {
  test("1 → 1×1, 2 → 2×1, 3–4 → 2×2", () => {
    expect([1, 2, 3, 4].map(gridFor)).toEqual([
      { cols: 1, rows: 1 },
      { cols: 2, rows: 1 },
      { cols: 2, rows: 2 },
      { cols: 2, rows: 2 },
    ]);
  });
});
