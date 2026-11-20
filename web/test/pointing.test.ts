import { describe, expect, test } from "bun:test";
import { pointing } from "@/lib/pointing";

describe("pointing store", () => {
  test("add keeps one copy of a pick, remove and clear work per project", () => {
    pointing.add("p", { kind: "part", part: "clip" });
    pointing.add("p", { kind: "part", part: "clip" });
    pointing.add("p", { kind: "point", part: "clip", position: [1, 2, 3], normal: null });
    pointing.add("q", { kind: "file", path: "brief.md" });
    expect(pointing.get("p")).toHaveLength(2);
    pointing.remove("p", { kind: "part", part: "clip" });
    expect(pointing.get("p").map((r) => r.kind)).toEqual(["point"]);
    pointing.clear("p");
    expect(pointing.get("p")).toHaveLength(0);
    expect(pointing.get("q")).toHaveLength(1);
  });
});
