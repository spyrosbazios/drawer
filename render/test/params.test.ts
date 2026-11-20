/** Customizer parameters: ported from the owner's earlier scad-params tests, reshaped as ScadParam. */
import { describe, expect, test } from "bun:test";
import type { ScadParam } from "@drawer/shared/api";
import { RenderError } from "@drawer/shared/contracts";
import { applyParams, defineArgs, parseParams } from "../src/params";

const byName = (src: string, name: string): ScadParam | undefined => parseParams(src).find((p) => p.name === name);
const names = (src: string): string[] => parseParams(src).map((p) => p.name);

describe("params: the module/function cutoff", () => {
  test("assignments after the first module are not parameters", () => {
    expect(names("\nwidth = 40;\nmodule thing() {\ninner = 99;\ndepth = 12;\n}\nafter = 7;\n")).toEqual(["width"]);
  });
  test("a leading function also closes the region", () => {
    expect(names("\na = 1;\nfunction f(x) = x * 2;\nb = 2;\n")).toEqual(["a"]);
  });
  test("no module keeps every top-level assignment", () => {
    expect(names("a = 1;\nb = 2;\nc = 3;")).toEqual(["a", "b", "c"]);
  });
});

describe("params: literals", () => {
  test("numbers, negatives and decimals", () => {
    const src = "w = 40;\nh = -2.5;\nz = 0.125;";
    expect(byName(src, "w")).toMatchObject({ type: "number", value: 40, line: 1 });
    expect(byName(src, "h")?.value).toBe(-2.5);
    expect(byName(src, "z")?.value).toBe(0.125);
  });
  test("booleans", () => {
    expect(byName("fancy = true;", "fancy")).toMatchObject({ type: "boolean", value: true });
    expect(byName("plain = false;", "plain")?.value).toBe(false);
  });
  test("strings, with escapes resolved", () => {
    expect(byName('label = "WORK\\"SHOP";', "label")).toMatchObject({ type: "string", value: 'WORK"SHOP' });
  });
  test("a // inside a string is not a comment", () => {
    expect(byName('url = "http://example.com";', "url")?.value).toBe("http://example.com");
  });
  test("numeric vectors are vectors; expressions are left out", () => {
    const src = "size = [10, 20, 30];\ncalc = 2 * 3;\nok = 5;";
    expect(names(src)).toEqual(["size", "ok"]);
    expect(byName(src, "size")).toMatchObject({ type: "vector", value: [10, 20, 30] });
  });
});

describe("params: annotations", () => {
  test("[min:max]", () => {
    expect(byName("w = 40; // [10:200]", "w")).toMatchObject({ min: 10, max: 200, step: null, options: null });
  });
  test("[min:step:max]", () => {
    expect(byName("w = 40; // [10:5:200]", "w")).toMatchObject({ min: 10, step: 5, max: 200 });
  });
  test("[a, b, c]", () => {
    expect(byName('mode = "hex"; // [hex, round, square]', "mode")?.options?.map((o) => o.value)).toEqual(["hex", "round", "square"]);
  });
  test("[1:One, 2:Two] keeps value and label apart", () => {
    expect(byName("n = 1; // [1:One, 2:Two]", "n")?.options).toEqual([
      { value: 1, label: "One" },
      { value: 2, label: "Two" },
    ]);
  });
  test("a range on a string is not a range", () => {
    expect(byName('s = "x"; // [1:10]', "s")).toMatchObject({ min: null, max: null });
  });
  test("prose after an annotation is the description", () => {
    expect(byName("w = 40; // [10:200] how wide it is", "w")?.description).toBe("how wide it is");
  });
  test("the comment line above is the description", () => {
    expect(byName("// outside width in mm\nw = 40;", "w")?.description).toBe("outside width in mm");
    expect(byName("// not mine\n\nw = 40;", "w")?.description).toBe("");
  });
});

describe("params: groups", () => {
  test("/* [Group] */ groups what follows", () => {
    const src = '/* [Size] */\nw = 1;\n/* [Look] */\nc = "red";';
    expect(byName(src, "w")?.group).toBe("Size");
    expect(byName(src, "c")?.group).toBe("Look");
  });
  test("[Hidden] parameters are left out", () => {
    expect(names("/* [Size] */\nw = 1;\n/* [Hidden] */\nsecret = 2;")).toEqual(["w"]);
  });
  test("an ordinary block comment is not a group", () => {
    const src = "/* just prose\n   over two lines */\nw = 1;";
    expect(byName(src, "w")).toMatchObject({ group: "", line: 3 });
  });
  test("an assignment inside a block comment is not a parameter", () => {
    expect(names("/* w = 99; */\nreal = 1;")).toEqual(["real"]);
  });
});

describe("params: robustness", () => {
  test("a re-assigned name yields one parameter, the last value", () => {
    const ps = parseParams("w = 1;\nw = 2;");
    expect(ps.length).toBe(1);
    expect(ps[0]?.value).toBe(2);
  });
  test("no parameters is empty", () => {
    expect(parseParams("module a() { cube(1); }\na();")).toEqual([]);
    expect(parseParams("")).toEqual([]);
  });
  test("malformed input does not throw", () => {
    for (const src of ["w = 40; // [", 'w = "unterminated;', "w = ; // [1:2]", "/* [Unclosed", "w=1;//[a,]"]) parseParams(src);
  });
  test("is pure", () => {
    const src = '/* [S] */\n// desc\nw = 40; // [1:100]\nmode = "a"; // [a,b]';
    expect(parseParams(src)).toEqual(parseParams(src));
  });
});

describe("applyParams", () => {
  const src = '// A bracket\n/* [Size] */\n// width\nwidth  =  40 ;   // [10:200] mm\nlabel = "hi"; // text\nholes = [3, 4];\nfancy = true;\nmodule m() { width = 1; }\nm();\n';

  test("replaces only the value expressions", () => {
    const out = applyParams(src, { width: 55.5, label: 'say "x"', holes: [5, 6], fancy: false });
    expect(out).toBe('// A bracket\n/* [Size] */\n// width\nwidth  =  55.5 ;   // [10:200] mm\nlabel = "say \\"x\\""; // text\nholes = [5, 6];\nfancy = false;\nmodule m() { width = 1; }\nm();\n');
    expect(byName(out, "label")?.value).toBe('say "x"');
  });
  test("no values leaves the source as it is", () => {
    expect(applyParams(src, {})).toBe(src);
  });
  test("an unknown name throws RenderError", () => {
    expect(() => applyParams(src, { depth: 1 })).toThrow(RenderError);
  });
  test("a wrong type throws RenderError", () => {
    expect(() => applyParams(src, { width: "wide" })).toThrow(RenderError);
    expect(() => applyParams(src, { fancy: 1 })).toThrow(RenderError);
    expect(() => applyParams(src, { holes: [1, 2, 3] })).toThrow(RenderError);
  });
});

describe("defineArgs: the -D injection boundary", () => {
  test("numbers, booleans, vectors bare; strings JSON-quoted; sorted by name", () => {
    expect(defineArgs({ w: 40, f: true, v: [1, 2.5, -3], s: "a" })).toEqual(["-D", "f=true", "-D", 's="a"', "-D", "v=[1, 2.5, -3]", "-D", "w=40"]);
  });
  test("a string carrying a quote cannot close its own literal", () => {
    expect(defineArgs({ label: '"; cube(999); //' })).toEqual(["-D", 'label="\\"; cube(999); //"']);
    expect(defineArgs({ s: "a\\b\nc" })).toEqual(["-D", 's="a\\\\b\\nc"']);
  });
  test("a non-identifier name or a non-finite number is refused", () => {
    expect(() => defineArgs({ "w; cube(9)": 1 })).toThrow(RenderError);
    expect(() => defineArgs({ "2bad": 1 })).toThrow(RenderError);
    expect(() => defineArgs({ w: Number.POSITIVE_INFINITY })).toThrow(RenderError);
    expect(() => defineArgs({ w: Number.NaN })).toThrow(RenderError);
  });
  test("nothing for no values", () => {
    expect(defineArgs(undefined)).toEqual([]);
    expect(defineArgs({})).toEqual([]);
  });
});
