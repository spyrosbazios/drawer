import type { TreeEntry } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import { hasAssembly } from "@/hooks/assembly";

const file = (path: string): TreeEntry => ({ path, type: "file", kind: "text" });

describe("whether to ask for the assembly report", () => {
  test("only when the tree lists assembly.json", () => {
    expect(hasAssembly([file("brief.md"), file("assembly.json")])).toBeTrue();
    expect(hasAssembly([file("brief.md"), file("parts/a.scad")])).toBeFalse();
    expect(hasAssembly([])).toBeFalse();
  });

  test("a folder or a nested file of that name is not the assembly", () => {
    expect(hasAssembly([{ path: "assembly.json", type: "dir" }])).toBeFalse();
    expect(hasAssembly([file("notes/assembly.json")])).toBeFalse();
  });
});
