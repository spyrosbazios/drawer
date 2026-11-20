import { describe, expect, test } from "bun:test";
import { boughtParts, partIdOf, sectionOf } from "@/core/parts";

describe("part files", () => {
  test("model and spec map to their part id", () => {
    expect(partIdOf("parts/clip.scad")).toBe("clip");
    expect(partIdOf("parts/cable-clip.part.json")).toBe("cable-clip");
    expect(partIdOf("parts/sub/clip.scad")).toBeNull();
    expect(partIdOf("parts/Clip.scad")).toBeNull();
    expect(partIdOf("src/clip.scad")).toBeNull();
  });

  test("outline sections", () => {
    expect(sectionOf("brief.md")).toBeNull();
    expect(sectionOf("assembly.json")).toBeNull();
    expect(sectionOf("parts/clip.scad")).toBeNull();
    expect(sectionOf("refs/a/b.stl")).toBe("references");
    expect(sectionOf("AGENTS.md")).toBe("memory");
    expect(sectionOf("notes/fit.md")).toBe("memory");
    expect(sectionOf("src/old.scad")).toBe("other");
  });

  test("bought parts are library instances, counted", () => {
    const spec = {
      title: "a",
      mates: [],
      instances: [
        { id: "s1", part: "_library/m3x8", translate: [0, 0, 0], rotate: [0, 0, 0] },
        { id: "s2", part: "_library/m3x8", translate: [0, 0, 0], rotate: [0, 0, 0] },
        { id: "t", part: "tray", translate: [0, 0, 0], rotate: [0, 0, 0] },
      ],
    } satisfies Parameters<typeof boughtParts>[0];
    expect(boughtParts(spec)).toEqual([{ id: "m3x8", count: 2 }]);
  });
});
