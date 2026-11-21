import { describe, expect, test } from "bun:test";
import { ApiFailure } from "@drawer/cli/client";
import type { NewSessionItem, Session, WriteResult } from "@drawer/shared/api";
import { formatPartReport } from "../src/format.ts";
import { drawerTools, executeTool, isNotePath, MAX_IMAGE_BYTES, type DrawerTool } from "../src/tools.ts";
import { context, fakeClient, PNG, report } from "./fakes.ts";
import { z } from "zod";

const byName = (name: string): DrawerTool => {
  const t = drawerTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const written = (overrides: Partial<WriteResult> = {}): WriteResult => ({
  project: "clip",
  path: "parts/cable-clip.scad",
  rev: "rev2",
  created: false,
  revisionId: "r2",
  check: { ok: true, diagnostics: [{ level: "warning", message: "unused variable", file: "parts/cable-clip.scad", line: 3 }] },
  part: "cable-clip",
  ...overrides,
});

describe("report text", () => {
  test("status line, failing first, warnings, then next", () => {
    const text = formatPartReport(report());
    const lines = text.split("\n");
    expect(lines[0]).toBe("Part cable-clip: DRAFT (5/6 gates)");
    expect(lines[1]).toBe("Failing:");
    expect(lines[2]).toContain("Bore [fail]: measured 5.6 mm, expected 6.4 ± 0.1 mm at (0, 0, 5). Hint: Increase bore_d by 0.8");
    expect(text.indexOf("Warnings:")).toBeGreaterThan(text.indexOf("Failing:"));
    expect(lines.at(-1)).toBe("Next: Widen the bore: set bore_d to 6.4");
  });

  test("a what-if says so", () => {
    expect(formatPartReport(report({ whatIf: true }))).toContain("what-if, nothing written");
  });
});

describe("write_model", () => {
  test("reads the rev, writes, returns check then report then the sheet", async () => {
    const calls: string[] = [];
    let sentRev: string | undefined;
    const client = fakeClient(
      {
        readFile: async () => ({ bytes: new Uint8Array(), rev: "rev1" }),
        writeFile: async (_slug, _path, _body, opts) => {
          sentRev = opts?.rev;
          return written();
        },
        evaluatePart: async () => report(),
        download: async () => PNG,
      },
      calls,
    );
    const out = await executeTool(byName("write_model"), context(client), { part: "cable-clip", content: "cube(1);" });
    expect(calls).toEqual(["readFile", "writeFile", "evaluatePart", "download"]);
    expect(sentRev).toBe("rev1");
    expect(out.ok).toBe(true);
    expect(out.text.indexOf("Check: ok")).toBeLessThan(out.text.indexOf("Part cable-clip: DRAFT"));
    expect(out.text).toContain("warning parts/cable-clip.scad:3: unused variable");
    expect(out.images).toEqual([PNG]);
    expect(out.imageUrls).toEqual(["/api/renders/k/sheet.png"]);
    expect(out.summary).toBe("cable-clip: draft 5/6, failing Bore");
    expect(out.text).toContain("Next: Widen the bore");
  });

  test("creates without a rev when the model does not exist", async () => {
    let sentRev: string | undefined = "unset";
    const client = fakeClient({
      readFile: async () => {
        throw new ApiFailure(404, "not_found", "no such file");
      },
      writeFile: async (_s, _p, _b, opts) => {
        sentRev = opts?.rev;
        return written({ created: true });
      },
      evaluatePart: async () => report({ render: null }),
    });
    const out = await executeTool(byName("write_model"), context(client), { part: "cable-clip", content: "cube(1);" });
    expect(sentRev).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.images).toEqual([]);
  });

  test("a conflict is reported, not thrown, and nothing is evaluated", async () => {
    const calls: string[] = [];
    const client = fakeClient(
      {
        readFile: async () => ({ bytes: new Uint8Array(), rev: "rev1" }),
        writeFile: async () => {
          throw new ApiFailure(409, "conflict", "rev mismatch", "rev9");
        },
      },
      calls,
    );
    const out = await executeTool(byName("write_model"), context(client), { part: "cable-clip", content: "x" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("current rev rev9");
    expect(calls).not.toContain("evaluatePart");
  });

  test("invalid input becomes an error result", async () => {
    const out = await executeTool(byName("write_model"), context(fakeClient({})), { part: "Bad Id", content: "x" });
    expect(out.ok).toBe(false);
    expect(out.text).toStartWith("invalid input");
  });
});

describe("edit_model", () => {
  test("sends the current rev with the replacement", async () => {
    let body: unknown;
    const client = fakeClient({
      readFile: async () => ({ bytes: new Uint8Array(), rev: "rev1" }),
      edit: async (_s, _p, b) => {
        body = b;
        return written();
      },
      evaluatePart: async () => report(),
      download: async () => PNG,
    });
    const out = await executeTool(byName("edit_model"), context(client), { part: "cable-clip", old: "a", new: "b" });
    expect(out.ok).toBe(true);
    expect(body).toMatchObject({ rev: "rev1", old: "a", new: "b" });
  });
});

describe("read_file", () => {
  test("_library paths read the library project", async () => {
    let slug = "";
    const client = fakeClient({
      readFile: async (s) => {
        slug = s;
        return { bytes: new TextEncoder().encode("# tolerances"), rev: "r" };
      },
    });
    const out = await executeTool(byName("read_file"), context(client), { path: "_library/notes/tolerances.md" });
    expect(slug).toBe("_library");
    expect(out.text).toContain("# tolerances");
  });

  test("binary files are refused", async () => {
    const client = fakeClient({ readFile: async () => ({ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0xc3]), rev: "r" }) });
    const out = await executeTool(byName("read_file"), context(client), { path: "refs/x.stl" });
    expect(out.ok).toBe(false);
  });
});

describe("set_library_profile", () => {
  test("replaces printer.json and materials.json in the library at their current revs", async () => {
    const writes: { slug: string; path: string; text: string; rev: string | undefined }[] = [];
    const client = fakeClient({
      readFile: async () => ({ bytes: new TextEncoder().encode("{}"), rev: "r1" }),
      writeFile: async (slug, path, bytes, opts) => {
        writes.push({ slug, path, text: new TextDecoder().decode(bytes), rev: opts?.rev });
        return { project: slug, path, rev: "r2", created: false, revisionId: "c", check: null, part: null };
      },
    });
    const printer = { name: "Mine", bed: [220, 220, 250], nozzleMm: 0.4, layerMm: 0.2, minWallMm: 1.2, maxOverhangDeg: 50, maxOverhangAreaMm2: 80, clearance: { sliding: 0.25, press: 0.05 } };
    const materials = [{ name: "PETG", densityGCm3: 1.27, minWallMm: null, notes: "" }];
    const out = await executeTool(byName("set_library_profile"), context(client), { printer, materials });
    expect(out.ok).toBe(true);
    expect(writes.map((w) => [w.slug, w.path, w.rev])).toEqual([
      ["_library", "printer.json", "r1"],
      ["_library", "materials.json", "r1"],
    ]);
    expect(JSON.parse(writes[0]?.text ?? "")).toEqual(printer);
    expect(JSON.parse(writes[1]?.text ?? "")).toEqual({ materials });
  });

  test("refuses a bed that is not three numbers, and an empty call", async () => {
    const client = fakeClient({});
    const bed = await executeTool(byName("set_library_profile"), context(client), { printer: { name: "x", bed: [1, 2], nozzleMm: 0.4, layerMm: 0.2, minWallMm: 1, maxOverhangDeg: 45, maxOverhangAreaMm2: 0, clearance: { sliding: 0, press: 0 } } });
    expect(bed.ok).toBe(false);
    expect((await executeTool(byName("set_library_profile"), context(client), {})).ok).toBe(false);
  });
});

describe("add_fact", () => {
  test("appends a fact line, retrying after a conflict", async () => {
    let writes = 0;
    let final = "";
    const client = fakeClient({
      readFile: async () => ({ bytes: new TextEncoder().encode("# Memory\n"), rev: `rev${writes}` }),
      writeFile: async (_s, _p, b) => {
        writes++;
        if (writes === 1) throw new ApiFailure(409, "conflict", "moved", "x");
        final = new TextDecoder().decode(b);
        return written({ path: "AGENTS.md", check: null, part: null });
      },
    });
    const out = await executeTool(byName("add_fact"), context(client), { category: "decision", text: "arm 1.8 mm" });
    expect(out.ok).toBe(true);
    expect(final).toBe("# Memory\n- [decision] arm 1.8 mm\n");
  });
});

describe("ask_user", () => {
  test("posts a question, polls until answered", async () => {
    const appended: NewSessionItem[] = [];
    let polls = 0;
    const client = fakeClient({
      waitAnswer: async (id, qid) => {
        polls++;
        expect(id).toBe("s1");
        expect(qid).toBe((appended[0] as { questionId: string }).questionId);
        return polls < 3 ? null : ["PETG, 6 mm cable"];
      },
      session: async () => ({ session: { status: "waiting" } as Session, items: [] }),
    });
    const out = await executeTool(byName("ask_user"), context(client, appended), { question: "Which cable?", options: ["5 mm", "6 mm"] });
    expect(appended[0]).toMatchObject({ type: "question", text: "Which cable?", options: ["5 mm", "6 mm"], multiple: false });
    expect(polls).toBe(3);
    expect(out.text).toBe("The person answered: PETG, 6 mm cable");
  });

  test("a multiple question gets every answer back, one entry each", async () => {
    const appended: NewSessionItem[] = [];
    const client = fakeClient({ waitAnswer: async () => ["top", "sides", "only the outer, 1 mm"] });
    const out = await executeTool(byName("ask_user"), context(client, appended), { question: "Which edges?", options: ["top", "bottom", "sides"], multiple: true });
    expect(appended[0]).toMatchObject({ type: "question", options: ["top", "bottom", "sides"], multiple: true });
    expect(out.text).toBe('The person gave 3 answers, each a picked option or their own words: ["top","sides","only the outer, 1 mm"]');
    expect(out.summary).toBe("answer: top; sides; only the outer, 1 mm");
  });

  test("ends with an error when the session was stopped, failed or deleted", async () => {
    for (const [status, expected] of [
      ["stopped", "the session is stopped"],
      ["failed", "the session is failed"],
      ["gone", "the session was deleted"],
    ] as const) {
      const calls: string[] = [];
      const client = fakeClient(
        {
          waitAnswer: async () => null,
          session: async () => {
            if (status === "gone") throw new ApiFailure(404, "not_found", "no such session");
            return { session: { status } as Session, items: [] };
          },
        },
        calls,
      );
      const out = await executeTool(byName("ask_user"), context(client), { question: "?" });
      expect(out.ok).toBe(false);
      expect(out.text).toContain(expected);
      expect(calls).toEqual(["waitAnswer", "session"]);
    }
  });

  test("keeps waiting while the session is still on", async () => {
    let polls = 0;
    const client = fakeClient({
      waitAnswer: async () => (++polls < 3 ? null : ["yes"]),
      session: async () => ({ session: { status: "waiting" } as Session, items: [] }),
    });
    const out = await executeTool(byName("ask_user"), context(client), { question: "?" });
    expect(out.text).toBe("The person answered: yes");
  });

  test("an abort ends a long poll in progress at once", async () => {
    const abort = new AbortController();
    const client = fakeClient({ waitAnswer: () => new Promise<string[] | null>(() => {}) });
    const running = executeTool(byName("ask_user"), context(client, [], abort.signal), { question: "?" });
    await Bun.sleep(5);
    abort.abort();
    await expect(running).rejects.toThrow("stopped");
  });

  test("too many or too long options are invalid input", async () => {
    const tooMany = await executeTool(byName("ask_user"), context(fakeClient({})), { question: "?", options: Array.from({ length: 13 }, (_, i) => `o${i}`) });
    expect(tooMany.text).toStartWith("invalid input");
    const tooLong = await executeTool(byName("ask_user"), context(fakeClient({})), { question: "?", options: ["o".repeat(201)] });
    expect(tooLong.text).toStartWith("invalid input");
  });

  test("an abort ends the wait by throwing", async () => {
    const abort = new AbortController();
    const client = fakeClient({
      waitAnswer: async () => {
        abort.abort();
        return null;
      },
    });
    await expect(executeTool(byName("ask_user"), context(client, [], abort.signal), { question: "?" })).rejects.toThrow("stopped");
  });
});

test("the agent cannot waive or record prints", () => {
  const names = drawerTools.map((t) => t.name);
  expect(names.some((n) => /waive|print/.test(n))).toBe(false);
});

describe("tool schemas", () => {
  // The Agent SDK sends schemas as JSON Schema draft-07; the API rejects that draft's tuples with
  // "JSON schema is invalid", which fails the whole turn before the agent says a word.
  test("no tool input uses a tuple", () => {
    for (const tool of drawerTools) {
      const schema = JSON.stringify(z.toJSONSchema(z.object(tool.input)));
      expect({ tool: tool.name, tuple: schema.includes("prefixItems") }).toEqual({ tool: tool.name, tuple: false });
    }
  });
});

describe("the agent reaches its project and the library only", () => {
  const badPaths = [
    "../../other/files/AGENTS.md",
    "parts/../../other/files/x.scad",
    "/etc/passwd",
    "./parts/x.scad",
    "parts//x.scad",
    "parts\\x.scad",
    "%2e%2e/other/x.md",
    "parts/x\u0000.scad",
    "_library/../other/x.scad",
    "",
  ];
  const attempts: [string, (path: string) => unknown][] = [
    ["read_file", (path) => ({ path })],
    ["measure_file", (path) => ({ path })],
    ["view_part", (path) => ({ path })],
    ["align", (path) => ({ path })],
    ["align", (path) => ({ path: "refs/scan.stl", to: { path } })],
    ["set_part_spec", (path) => ({ part: "scan", title: "Scan", source: "scanned", scan: { file: path, rotate: [0,0,0], translate: [0,0,0] } })],
    ["features", (path) => ({ path })],
    ["fit", (path) => ({ path, at: [0, 0, 0] })],
    ["slice", (path) => ({ path, axis: "z", at: 1 })],
    ["probe", (path) => ({ path, from: [0, 0, 0], axis: "z" })],
    ["section", (path) => ({ path, axis: "z", at: 1 })],
    ["list_files", (path) => ({ prefix: path === "" ? "../" : path })],
    ["compare", (path) => ({ a: { path }, b: { part: "x" } })],
  ];
  for (const [name, input] of attempts) {
    test(`${name} refuses every escape without calling the server`, async () => {
      for (const path of badPaths) {
        const calls: string[] = [];
        const out = await executeTool(byName(name), context(fakeClient({}, calls)), input(path));
        expect({ path, ok: out.ok, calls }).toEqual({ path, ok: false, calls: [] });
      }
    });
  }

  test("note paths are checked segment by segment", () => {
    for (const ok of ["AGENTS.md", "brief.md", "notes/log.md", "notes/fits/clip.md", "_library/tolerances.md", "_library/notes/petg.md"]) expect({ ok, valid: isNotePath(ok) }).toEqual({ ok, valid: true });
    for (const bad of ["notes/../../../other/files/x.md", "notes/./x.md", "notes/x.txt", "_library/../x.md", "_library/sub/x.md", "parts/x.md", "notes/.md", "notes//x.md", "other.md"]) {
      expect({ bad, valid: isNotePath(bad) }).toEqual({ bad, valid: false });
    }
  });

  test("write_note and add_fact refuse an escaping note path without calling the server", async () => {
    for (const [name, input] of [
      ["write_note", { path: "notes/../../../other/files/x.md", content: "x" }],
      ["add_fact", { category: "learned", text: "x", path: "notes/../../other/files/AGENTS.md" }],
    ] as const) {
      const calls: string[] = [];
      const out = await executeTool(byName(name), context(fakeClient({}, calls)), input);
      expect(out.ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("part ids, library part references, revisions and folder names are checked", async () => {
    const cases: [string, unknown][] = [
      ["evaluate_part", { part: "../other" }],
      ["attempts", { part: "a/b" }],
      ["restore_attempt", { part: "clip", revision_id: "../HEAD" }],
      ["restore_attempt", { part: "clip", revision_id: "HEAD~1" }],
      ["compare", { a: { part: "../other/x" }, b: { part: "x" } }],
      ["compare", { a: { part: "x", at: "main" }, b: { part: "x" } }],
      ["view_part", { part: "_library/x" }],
      ["set_assembly", { title: "t", instances: [{ id: "a", part: "../other/x", translate: [0, 0, 0], rotate: [0, 0, 0] }], mates: [] }],
      ["set_assembly", { title: "t", instances: [{ id: "a", part: "_library/../x", translate: [0, 0, 0], rotate: [0, 0, 0] }], mates: [] }],
      ["import_reference", { url: "https://www.printables.com/model/1", name: "../escape" }],
    ];
    for (const [name, input] of cases) {
      const calls: string[] = [];
      const out = await executeTool(byName(name), context(fakeClient({}, calls)), input);
      expect({ name, input, ok: out.ok, calls }).toEqual({ name, input, ok: false, calls: [] });
    }
  });

  test("a library part reference is accepted in an assembly", async () => {
    let sent: unknown;
    const client = fakeClient({
      putAssembly: async (_slug, spec) => {
        sent = spec;
        throw new ApiFailure(400, "invalid", "stop here");
      },
    });
    await executeTool(byName("set_assembly"), context(client), { title: "t", instances: [{ id: "a", part: "_library/m3-nut", translate: [0, 0, 0], rotate: [0, 0, 0] }], mates: [] });
    expect(sent).toMatchObject({ instances: [{ part: "_library/m3-nut" }] });
  });
});

describe("import_reference", () => {
  test("only https pages on the supported sites reach the server", async () => {
    const refused = [
      "http://www.printables.com/model/1",
      "https://example.com/model.stl",
      "http://127.0.0.1:3050/api/health",
      "https://printables.com.evil.net/x",
      "https://user:pw@printables.com/x",
      "file:///etc/passwd",
      "not a url",
    ];
    for (const url of refused) {
      const calls: string[] = [];
      const out = await executeTool(byName("import_reference"), context(fakeClient({}, calls)), { url });
      expect({ url, ok: out.ok, calls }).toEqual({ url, ok: false, calls: [] });
      expect(out.text).toContain("web app");
    }
    for (const url of ["https://www.printables.com/model/1", "https://thingiverse.com/thing:2", "https://makerworld.com/en/models/3", "https://www.cults3d.com/x", "https://www.myminifactory.com/object/4"]) {
      const calls: string[] = [];
      const client = fakeClient({ importInto: async () => ({ project: "clip", dir: "refs/x", written: [], skipped: [], revisionId: "r" }) }, calls);
      const out = await executeTool(byName("import_reference"), context(client), { url });
      expect({ url, ok: out.ok, calls }).toEqual({ url, ok: true, calls: ["importInto"] });
    }
  });
});

describe("images to the model", () => {
  test("at most 8, none over 4 MB, and the text says how many were left out", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const images = [big, ...Array.from({ length: 10 }, () => PNG)];
    const imageUrls = images.map((_, i) => `/api/renders/k/${i}.png`);
    const many: DrawerTool = {
      name: "many",
      description: "",
      input: {},
      run: async () => ({ ok: true, text: "pictures", summary: "s", images, imageUrls }),
    };
    const out = await executeTool(many, context(fakeClient({})), {});
    expect(out.images.length).toBe(8);
    expect(out.imageUrls).toEqual(imageUrls.slice(1, 9));
    expect(out.text).toBe("pictures\n(left out: 1 image(s) over 4 MB, 2 image(s) beyond the first 8)");
  });
});

describe("attachments", () => {
  const ID = "0123456789abcdef";
  const OTHER = "fedcba9876543210";
  const att = { id: ID, name: "Fan 80.stl", mediaType: "model/stl", size: 20, kind: "mesh" as const, url: `/api/attachments/${ID}`, filedAs: null };
  const photo = { ...att, id: OTHER, name: "jaw.jpg", mediaType: "image/jpeg", kind: "image" as const, url: `/api/attachments/${OTHER}` };
  const detail = () => ({
    session: {} as Session,
    items: [{ seq: 1, version: 1, at: "", type: "user" as const, text: "", refs: [], attachments: [att, photo], author: "web" }],
  });

  test("list_attachments names every attachment of the session", async () => {
    const out = await executeTool(byName("list_attachments"), context(fakeClient({ session: async () => detail() })), {});
    expect(out.text).toContain(`[attached ${ID}: "Fan 80.stl", mesh`);
    expect(out.text).toContain(`[attached ${OTHER}: "jaw.jpg", image`);
  });

  test("view_attachment returns an image by its bytes", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const out = await executeTool(byName("view_attachment"), context(fakeClient({ session: async () => detail(), attachmentBytes: async () => ({ bytes: jpeg, name: "jaw.jpg" }) })), { id: OTHER });
    expect(out.ok).toBe(true);
    expect(out.images).toEqual([jpeg]);
    expect(out.imageUrls).toEqual([photo.url]);
  });

  test("an id that is not this session's is refused before any download", async () => {
    const calls: string[] = [];
    const out = await executeTool(byName("view_attachment"), context(fakeClient({ session: async () => detail() }, calls)), { id: "aaaaaaaaaaaaaaaa" });
    expect(out.ok).toBe(false);
    expect(calls).toEqual(["session"]);
  });

  test("file_attachment files into the project only, and reports an existing path", async () => {
    const filed: unknown[] = [];
    const client = fakeClient({
      session: async () => detail(),
      fileAttachment: async (id, body) => {
        filed.push({ id, body });
        if (body.path === "refs/taken.stl") throw new ApiFailure(409, "conflict", "exists", "r1");
        return { attachment: { ...att, filedAs: body.path }, write: written({ path: body.path, part: null, check: null }) };
      },
    });
    const ok = await executeTool(byName("file_attachment"), context(client), { id: ID, path: "refs/fan-80mm.stl" });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("as refs/fan-80mm.stl");
    expect(ok.text).toContain("measure_file");
    expect(filed).toEqual([{ id: ID, body: { path: "refs/fan-80mm.stl" } }]);
    expect((await executeTool(byName("file_attachment"), context(client), { id: ID, path: "refs/taken.stl" })).text).toContain("already exists");
    expect((await executeTool(byName("file_attachment"), context(client), { id: ID, path: "_library/fan.stl" })).ok).toBe(false);
    expect((await executeTool(byName("file_attachment"), context(client), { id: ID, path: "../fan.stl" })).ok).toBe(false);
  });
});
