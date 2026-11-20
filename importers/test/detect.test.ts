import { describe, expect, test } from "bun:test";
import { createImporters, detectSite } from "../src/index";
import { parseModelUrl } from "../src/detect";

describe("detect", () => {
  const cases: Array<[string, string, string | null]> = [
    ["https://www.printables.com/model/642560-apple-earpods-earbuds-holder-wrap-usb-c", "printables", "642560"],
    ["https://printables.com/model/642560", "printables", "642560"],
    ["https://www.printables.com/de/model/642560-slug?lang=de#comments", "printables", "642560"],
    ["https://www.thingiverse.com/thing:4932", "thingiverse", "4932"],
    ["https://thingiverse.com/thing:4932/files", "thingiverse", "4932"],
    ["http://www.thingiverse.com/thing:4932#comments", "thingiverse", "4932"],
    ["https://makerworld.com/en/models/1054000-remote-control-cover", "makerworld", "1054000"],
    ["https://makerworld.com/de/models/1400373-seed-starter#profileId-1452154", "makerworld", "1400373"],
    ["https://makerworld.com/models/1054000", "makerworld", "1054000"],
    ["https://cults3d.com/en/3d-model/home/print-in-place-cute-lucky-bunny", "cults3d", "print-in-place-cute-lucky-bunny"],
    ["https://cults3d.com/fr/modele-3d/maison/un-lapin", "cults3d", "un-lapin"],
    ["https://cults3d.com/en/users/someone", "generic", null],
    ["https://cults3d.com/en/3d-model/art/some-slug?utm=x", "cults3d", "some-slug"],
    ["https://www.myminifactory.com/object/3d-print-ino-and-melicertes-at-the-palace-of-versailles-france-12345", "myminifactory", "12345"],
    ["https://myminifactory.com/fr/object/3d-print-dragon-98765", "myminifactory", "98765"],
    ["https://example.com/some/page", "generic", null],
    ["https://www.printables.com/@someone", "generic", null],
    ["https://www.thingiverse.com/search?q=cube", "generic", null],
    ["https://notprintables.com/model/1-x", "generic", null],
    ["https://evil.example/?u=https://www.printables.com/model/1-x", "generic", null],
    ["not a url", "generic", null],
    ["ftp://www.printables.com/model/1-x", "generic", null],
  ];
  for (const [url, site, id] of cases) {
    test(url, () => {
      expect(detectSite(url)).toBe(site as ReturnType<typeof detectSite>);
      expect(parseModelUrl(url)?.id ?? null).toBe(id);
    });
  }

  test("is exposed on the Importers object", () => {
    expect(createImporters({}).detect("https://www.thingiverse.com/thing:1")).toBe("thingiverse");
  });
});
