import { describe, expect, test } from "bun:test";
import { isValidSlug, slugError, slugify } from "@/core/slug";

describe("slug validation", () => {
  test("accepts the contract's pattern [a-z0-9][a-z0-9-]*", () => {
    for (const ok of ["a", "0", "earbuds-holder", "a-b-c", "3d-print-2", "x--y"]) expect(isValidSlug(ok)).toBe(true);
  });

  test("rejects everything else", () => {
    for (const bad of ["", "-a", "A", "a_b", "a b", "a/b", "ünï", "a.b", "_library", "a!"]) expect(isValidSlug(bad)).toBe(false);
  });

  test("slugError explains, and is null for a valid slug", () => {
    expect(slugError("ok-slug")).toBeNull();
    expect(slugError("")).toContain("name");
    expect(slugError("Bad Slug")).toContain("lower-case");
  });

  test("slugify turns a free-form name into a valid slug", () => {
    expect(slugify("Earbuds Holder")).toBe("earbuds-holder");
    expect(slugify("  Mäkerworld: Phone Stand (v2)!  ")).toBe("makerworld-phone-stand-v2");
    expect(slugify("---")).toBe("");
    for (const name of ["Hello World", "  a  b  ", "3D Printed Case #4", "Crème brûlée"]) {
      const s = slugify(name);
      expect(s === "" || isValidSlug(s)).toBe(true);
    }
  });
});
