import type { PartReport, PartSpec } from "@drawer/shared/api";
import type { ToolClient, ToolContext } from "../src/tools.ts";
import type { NewSessionItem } from "@drawer/shared/api";

/** A ToolClient whose unimplemented methods throw, so a test sees exactly which calls a tool makes. */
export function fakeClient(impl: Partial<ToolClient>, calls: string[] = []): ToolClient {
  return new Proxy(impl, {
    get(target, prop: string) {
      const fn = (target as Record<string, unknown>)[prop];
      if (typeof fn !== "function") {
        return () => {
          calls.push(prop);
          throw new Error(`unexpected call: ${prop}`);
        };
      }
      return (...args: unknown[]) => {
        calls.push(prop);
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as ToolClient;
}

export function context(client: ToolClient, appended: NewSessionItem[] = [], signal = new AbortController().signal): ToolContext {
  return {
    client,
    project: "clip",
    sessionId: "s1",
    signal,
    answerWait: 0,
    append: async (item) => {
      appended.push(item);
    },
  };
}

const spec: PartSpec = {
  title: "Cable clip",
  class: "clip",
  description: "",
  source: "printed",
  material: "PETG",
  strictness: "standard",
  dimensions: [],
  waivers: [],
  prints: [],
};

export function report(overrides: Partial<PartReport> = {}): PartReport {
  return {
    project: "clip",
    part: "cable-clip",
    revisionId: "r2",
    status: "draft",
    passed: 5,
    total: 6,
    gates: [
      { id: "parses", label: "Parses", status: "pass", measured: null, expected: null, detail: null, hint: null, at: null },
      {
        id: "dim:bore",
        label: "Bore",
        status: "fail",
        measured: "5.6 mm",
        expected: "6.4 ± 0.1 mm",
        detail: null,
        hint: "Increase bore_d by 0.8",
        at: [0, 0, 5],
      },
      { id: "overhang", label: "Overhang", status: "warn", measured: "40 mm²", expected: "≤ 25 mm²", detail: null, hint: "Chamfer the underside", at: null },
    ],
    spec,
    mesh: { format: "stl", triangles: 100, bbox: { min: [0, 0, 0], max: [20, 10, 8], size: [20, 10, 8] }, volumeCm3: 1.2 },
    analysis: null,
    render: { key: "k", mesh: "/api/renders/k/mesh.stl", views: { iso: "/api/renders/k/iso.png" }, sheet: "/api/renders/k/sheet.png" },
    params: [{ name: "bore_d", type: "number", value: 5.6, group: "Fit", description: "", min: 4, max: 8, step: 0.1, options: null, line: 4 }],
    massG: 1.5,
    next: ["Widen the bore: set bore_d to 6.4", "Then chamfer"],
    whatIf: false,
    seconds: 1,
    evaluatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
