import { expect, test } from "bun:test";
import { differences, normalise } from "../../scripts/parity";

const KEY = "a".repeat(64);

test("normalise drops timings and the cache keys of renders, and keeps the rest", () => {
  const report = {
    status: "passed",
    seconds: 1.25,
    evaluatedAt: "2026-11-21T10:00:00.000Z",
    render: { key: KEY, mesh: `/api/renders/${KEY}/mesh.stl`, views: { iso: `/api/renders/${KEY}/iso.png` } },
    instances: [{ id: "lid", mesh: `/api/renders/${KEY}/mesh.stl` }],
    gates: [{ id: "min_wall", measured: "1.2 mm" }],
  };
  expect(normalise(report)).toEqual({
    status: "passed",
    render: { mesh: "/api/renders/*/mesh.stl", views: { iso: "/api/renders/*/iso.png" } },
    instances: [{ id: "lid", mesh: "/api/renders/*/mesh.stl" }],
    gates: [{ id: "min_wall", measured: "1.2 mm" }],
  });
});

test("differences is empty for equal reports and for numbers within the tolerance", () => {
  const report = { massG: 12.5, gates: [{ id: "solid", status: "pass", at: null }] };
  expect(differences(report, structuredClone(report), 0)).toEqual([]);
  expect(differences({ volume: 1000 }, { volume: 1000 + 1e-7 }, 1e-9)).toEqual([]);
  expect(differences({ wall: 0.4 }, { wall: 0.4 + 1e-10 }, 1e-9)).toEqual([]);
});

test("differences names each changed value by its path", () => {
  const expected = { status: "passed", gates: [{ id: "min_wall", status: "pass", measured: "1.6 mm" }], massG: 12.5 };
  const actual = { status: "failed", gates: [{ id: "min_wall", status: "fail", measured: "1.2 mm" }], massG: 12.6 };
  expect(differences(expected, actual, 1e-9)).toEqual([
    'gates[0].measured: "1.6 mm" -> "1.2 mm"',
    'gates[0].status: "pass" -> "fail"',
    "massG: 12.5 -> 12.6",
    'status: "passed" -> "failed"',
  ]);
});

test("differences reports missing and added fields, entries and whole reports", () => {
  expect(differences({ wall: null }, {}, 0)).toEqual(["wall: null -> nothing"]);
  expect(differences({}, { proxy: "x" }, 0)).toEqual(['proxy: nothing -> "x"']);
  expect(differences({ gates: [1, 2] }, { gates: [1] }, 0)).toEqual(["gates: 2 entries -> 1"]);
  expect(differences(undefined, { status: "passed" }, 0)).toEqual(['(whole report): nothing -> {"status":"passed"}']);
  expect(differences({ at: [0, 0, 1] }, { at: null }, 0)).toEqual(["at: [0,0,1] -> null"]);
});
