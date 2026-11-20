import { describe, expect, test } from "bun:test";
import type { AssemblyReport, GateResult, Mate } from "@drawer/shared/api";
import { bomCsv, clashingPairs, explodeOffsets, failingInstances, mateExpected, partHome, sendBackMessage, toColumnMajor } from "@/components/assembly/assembly-model";

const gate = (id: string, status: GateResult["status"]): GateResult => ({ id, label: id, status, measured: null, expected: null, detail: null, hint: null, at: null });

const fitMate: Mate = { id: "fit", label: "Fit", a: "a", b: "b", fit: "clearance", min: 0.1, max: 0.3 };
const pinMate: Mate = { id: "pin", label: "Pin", a: "c", b: "d", fit: "press" };

const report: Pick<AssemblyReport, "pairs" | "spec" | "gates"> = {
  spec: {
    title: "t",
    instances: [],
    mates: [fitMate, pinMate],
  },
  pairs: [
    { a: "b", b: "a", gapMm: 0.05, overlapCm3: 0 },
    { a: "c", b: "d", gapMm: 0, overlapCm3: 0.02 },
    { a: "e", b: "f", gapMm: 0, overlapCm3: 0.004 },
    { a: "g", b: "h", gapMm: 0, overlapCm3: 0.0001 },
  ],
  gates: [gate("clash", "fail"), gate("mate:fit", "fail"), gate("mate:pin", "pass")],
};

describe("assembly model", () => {
  test("a row-major matrix is transposed for three.js", () => {
    const m = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
    const c = toColumnMajor(m);
    expect(c.slice(12, 15)).toEqual([10, 20, 30]);
    expect(c[3]).toBe(0);
    expect(() => toColumnMajor([1])).toThrow();
  });

  test("explode moves instances away from the common centre", () => {
    const o = explodeOffsets(
      new Map([
        ["l", [-10, 0, 0]],
        ["r", [10, 0, 0]],
      ]),
      1,
    );
    expect(o.get("l")).toEqual([-10, 0, 0]);
    expect(o.get("r")).toEqual([10, 0, 0]);
    expect(explodeOffsets(new Map([["only", [5, 5, 5]]]), 1, 8).get("only")).toEqual([0, 0, 2]);
    expect(explodeOffsets(new Map([["l", [-1, 0, 0]]]), 0).get("l")).toEqual([0, 0, 0]);
  });

  test("clashes skip press fits and overlaps within tolerance", () => {
    expect(clashingPairs(report).map((p) => p.a)).toEqual(["e"]);
  });

  test("failing instances come from clashes and failing mates", () => {
    expect([...failingInstances(report)].sort()).toEqual(["a", "b", "e", "f"]);
  });

  test("mate expectations read as words", () => {
    expect(mateExpected(fitMate)).toBe("gap 0.1–0.3 mm");
    expect(mateExpected(pinMate)).toContain("press");
  });

  test("library parts are recognised", () => {
    expect(partHome("_library/m3x8")).toEqual({ library: true, id: "m3x8" });
    expect(partHome("tray")).toEqual({ library: false, id: "tray" });
  });

  test("BOM CSV quotes cells and totals the printed mass", () => {
    const csv = bomCsv(
      [
        { part: "tray", title: "Tray, large", count: 2, source: "printed", material: "PETG", massG: 10.5 },
        { part: "_library/m3", title: 'Screw "M3"', count: 4, source: "bought", material: null, massG: null },
      ],
      21,
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("part,title,count,source,material,mass_g_each,mass_g_total");
    expect(lines[1]).toBe('tray,"Tray, large",2,printed,PETG,10.5,21');
    expect(lines[2]).toBe('_library/m3,"Screw ""M3""",4,bought,,,');
    expect(lines[3]).toBe(",total printed,,,,,21");
  });

  test("send back names failing gates and pairs", () => {
    const msg = sendBackMessage(report);
    expect(msg).toContain("(clash)");
    expect(msg).toContain("(mate:fit)");
    expect(msg).toContain("pair e × f");
    expect(msg).not.toContain("mate:pin");
  });
});
