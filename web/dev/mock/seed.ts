/**
 * The mock's starting data:
 * - desk-organiser: tray (passed), cable-clip (draft: min wall 1.2 < 1.6, five attempts with a branch),
 *   pen-cup (spec, no model); an assembly with four library screws and one clash (the clip into the tray
 *   wall); references and notes; a session waiting for an answer.
 * - spool-holder: three passed parts, one printed; a finished session.
 * - earbuds-holder: an older project with notes, a loose .scad and meshes, no parts.
 * - the library: printer and materials, notes, two bought parts.
 */
import { LIBRARY_SLUG } from "../../../shared/src/api";
import type { AssemblySpec } from "../../../shared/src/api";
import { cubeStl, png } from "./geometry";
import { MATERIALS, PRINTER, modelSource, seedPart } from "./parts";
import { seedSession } from "./sessions";
import { createProject, encoder, put } from "./store";
import type { StoredProject } from "./store";

const write = (p: StoredProject, path: string, content: string | Uint8Array, author = "system") => put(p, path, typeof content === "string" ? encoder.encode(content) : content, author, `Add ${path}`);
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

const clipModel = (arm: number, slot = 4.2) =>
  modelSource(
    "Cable clip: holds a 6 mm cable on the 4 mm tray edge",
    [
      { name: "arm_t", value: arm, range: "0.8:0.1:3", note: "Snap arm thickness" },
      { name: "slot", value: slot, range: "3:0.1:6", note: "Slot for the tray edge" },
      { name: "bore", value: 6.4, range: "5:0.1:8", note: "Cable bore" },
      { name: "height", value: 12, range: "8:0.5:20", note: "Clip height" },
    ],
    "  difference() {\n    cube([24, arm_t + slot + 4, height]);\n    translate([-1, arm_t, -1]) cube([26, slot, height - 2]);\n  }",
  );

const trayModel = modelSource(
  "Desk tray for pens",
  [
    { name: "width", value: 120, range: "60:1:200", note: "Outer width" },
    { name: "depth", value: 80, range: "40:1:150", note: "Outer depth" },
    { name: "height", value: 25, range: "10:1:60", note: "Wall height" },
    { name: "wall", value: 2, range: "1.2:0.1:4", note: "Wall thickness" },
    { name: "floor", value: 2, range: "1:0.1:4", note: "Floor thickness" },
  ],
  "  difference() {\n    cube([width, depth, height]);\n    translate([wall, wall, floor]) cube([width - 2 * wall, depth - 2 * wall, height]);\n  }",
);

const simple = (title: string, params: [string, number, string][]) =>
  modelSource(
    title,
    params.map(([name, value, range]) => ({ name, value, range, note: name })),
    "  cube([10, 10, 10]);",
  );

function library(): void {
  const lib = createProject(LIBRARY_SLUG, "Library");
  write(lib, "AGENTS.md", "# Library\n\nShared notes for every project.\n\n- [rule] Read printer.json and tolerances.md before sizing anything\n- [rule] Dimensions are millimetres\n");
  write(lib, "tolerances.md", "# Tolerances\n\n- [rule] Press fit: hole = pin - 0.15 mm\n- [rule] Sliding fit: hole = pin + 0.25 mm\n- [result] PETG snap arms under 1.6 mm cracked twice\n");
  write(lib, "materials.md", "# Materials\n\n- [material] PETG shrinks about 0.3 percent\n- [material] PLA creeps above 50 C\n");
  write(lib, "printer.json", `${JSON.stringify(PRINTER, null, 2)}\n`);
  write(lib, "materials.json", `${JSON.stringify({ materials: MATERIALS }, null, 2)}\n`);
  seedPart(LIBRARY_SLUG, "m3x8-screw", { title: "M3 x 8 screw", class: "screw", source: "bought", dimensions: [] }, [{ text: "// M3 x 8 socket head screw\ncylinder(d = 3, h = 8);\n", message: "screw" }]);
  seedPart(LIBRARY_SLUG, "magnet-6x2", { title: "Magnet 6 x 2", class: "magnet", source: "bought", dimensions: [] }, [{ text: "// 6 x 2 mm disc magnet\ncylinder(d = 6, h = 2);\n", message: "magnet" }]);
}

function deskOrganiser(): void {
  const p = createProject("desk-organiser", "Desk organiser");
  p.meta.description = "A tray for pens, a cup, and a clip that holds a cable on the tray edge.";
  write(p, "brief.md", "# Desk organiser\n\nA desk organiser: tray for pens, a cup, and a clip that holds a 6 mm cable on the tray edge. Fits on the left of my monitor stand.\n", "web");
  write(
    p,
    "AGENTS.md",
    "# Desk organiser\n\nProject memory. Read [[brief]] first.\n\n- [decision] PETG, standard strictness\n- [measurement] The tray edge is 4.0 mm (measured from tray r7)\n- [decision] The clip is a snap fit; arm at least 1.6 mm per [[Library: tolerances]]\n- [todo] Pen cup: wait for the photo of the pens\n",
    "agent",
  );
  write(p, "notes/fit-log.md", "# Fit log\n\n- [result] Clip r2 too loose on the edge: slot 4.4 -> 4.2\n- [result] Tray r1 printed fine, no warping\n", "agent");
  write(p, "refs/desk-edge.png", png(200, 80, 40), "web");
  write(p, "refs/headphone-hook/source.md", "# Headphone hook\n\n- [source] https://www.printables.com/model/1234-headphone-hook\n", "import");
  write(p, "refs/headphone-hook/hook.stl", cubeStl(30), "import");

  seedPart("desk-organiser", "tray", { title: "Pen tray", class: "tray", dimensions: [{ id: "width", label: "Width", kind: "size", axis: "x", nominal: 120, tol: 0.5 }, { id: "env", label: "Envelope", kind: "envelope", box: [130, 90, 30] }] }, [
    { text: trayModel, message: "first tray" },
  ]);
  seedPart(
    "desk-organiser",
    "cable-clip",
    {
      title: "Cable clip",
      class: "snap-fit clip",
      description: "Holds a 6 mm cable on the 4 mm tray edge; openable by hand.",
      dimensions: [
        { id: "bore", label: "Cable bore", kind: "hole", axis: "z", at: 6, near: [12, 4], nominal: 6.4, tol: 0.1 },
        { id: "slot", label: "Tray slot", kind: "gap", axis: "y", from: [12, 3, 6], nominal: 4.2, tol: 0.1 },
        { id: "height", label: "Height", kind: "size", axis: "z", nominal: 12, tol: 0.2 },
        { id: "arm-wall", label: "Snap arm wall", kind: "min_wall", min: 1.6 },
      ],
    },
    [
      { text: clipModel(1.0, 4.6), message: "first clip" },
      { text: clipModel(1.0, 4.4), message: "slot 4.6 -> 4.4" },
      { text: clipModel(1.2, 4.2), message: "slot 4.4 -> 4.2, arm 1.2" },
      { text: clipModel(0.9, 4.2).replace("// Cable clip", "Cable clip"), message: "thinner arm, no header", parentIndex: 1 },
      { text: clipModel(1.2, 4.2), message: "bore 6.4", parentIndex: 2 },
    ],
  );
  seedPart("desk-organiser", "pen-cup", { title: "Pen cup", class: "cup", dimensions: [{ id: "inner", label: "Inner diameter", kind: "hole", axis: "z", at: 10, near: [0, 0], nominal: 60, tol: 1 }] }, []);

  const assembly: AssemblySpec = {
    title: "Desk organiser",
    instances: [
      { id: "tray", part: "tray", translate: [0, 0, 0], rotate: [0, 0, 0] },
      // 1.4 mm into the tray's front wall: the one clash.
      { id: "clip", part: "cable-clip", translate: [90, -8, 13], rotate: [0, 0, 0] },
      ...[0, 1, 2, 3].map((i) => ({ id: `screw-${i + 1}`, part: `${LIBRARY_SLUG}/m3x8-screw`, translate: [i % 2 ? 110 : 7, i < 2 ? 7 : 70, -11] as [number, number, number], rotate: [0, 0, 0] as [number, number, number] })),
    ],
    mates: [{ id: "feet", label: "Screw heads touch the tray floor", a: "tray", b: "screw-1", fit: "contact" }],
  };
  write(p, "assembly.json", `${JSON.stringify(assembly, null, 2)}\n`, "agent");

  const preview = `data:image/png;base64,${Buffer.from(png(240, 150, 20)).toString("base64")}`;
  // One session that shows every kind of row: attachments (one filed), a group of steps with a failure and a
  // picture, markdown with code, a notice, an open question.
  seedSession(
    "desk-organiser",
    "Clip for a 6 mm cable that snaps on the tray edge",
    [
      {
        type: "user",
        text: "The clip arm snapped at the root on the first print. Make it a bit stiffer; the photo and the tray mount are attached.",
        attachments: [
          { name: "broken-clip.png", bytes: png(320, 240, 40) },
          { name: "tray-mount.stl", bytes: cubeStl(20), filedAs: "refs/tray-mount.stl" },
        ],
        refs: [
          { kind: "part", part: "cable-clip" },
          { kind: "point", part: "cable-clip", position: [12, 4, 6], normal: null },
        ],
      },
      { type: "reasoning", reasoningId: "k1", text: "The photo shows the arm cracked right where it meets the body.\n\nThat is a thin root, so check the wall gate before touching anything else.", status: "done", seconds: 6 },
      { type: "tool", callId: "s1", name: "overview", summary: "overview: 3 parts, assembly draft", status: "ok", result: "tray passed, cable-clip draft, pen-cup no model", images: [] },
      { type: "tool", callId: "s2", name: "file_attachment", summary: "file_attachment tray-mount.stl refs/tray-mount.stl", status: "ok", result: 'Filed "tray-mount.stl" as refs/tray-mount.stl.', images: [] },
      { type: "tool", callId: "s3", name: "write_model", summary: "cable-clip.scad r3", status: "error", result: "ERROR: Parser error in file cable-clip.scad, line 7: syntax error", images: [] },
      { type: "tool", callId: "s4", name: "write_model", summary: "cable-clip.scad r4: draft 9/10, failing Snap arm wall", status: "ok", result: "Snap arm wall 1.2 mm, needs 1.6 mm.", images: [preview] },
      { type: "tool", callId: "s5", name: "report", summary: "cable-clip: draft 9/10, failing Snap arm wall", status: "ok", result: "Raise arm_t.", images: [] },
      {
        type: "assistant",
        text: "The clip builds and fits the edge, but the **snap arm is 1.2 mm**; the library says PETG arms under 1.6 mm crack.\n\n- Wall at the root: 1.2 mm (needs 1.6 mm)\n- Everything else passes\n\n```openscad\nmodule arm(arm_t = 1.2, height = 12) {\n  cube([24, arm_t, height]);\n}\n```\n\nThe slot stays at 4.2 mm so it still grips the 4 mm edge.",
      },
      { type: "notice", level: "info", text: "Session resumed on runner mock-runner" },
      { type: "reasoning", reasoningId: "k2", text: "Going from 1.2 to 1.8 mm makes the arm stiffer, but it must still flex enough to snap onto the 4 mm edge.\n\nWorth confirming before changing the model.", status: "done", seconds: 9 },
      { type: "question", questionId: "q-seed", text: "Before I change it: raise arm_t from 1.2 to 1.8 mm? It stays openable by hand.", options: ["Agree", "Change something"] },
    ],
    "waiting",
    12,
  );
  // A session mid-turn: the thread ends in the live tail.
  seedSession(
    "desk-organiser",
    "Spacer for the pen cup",
    [
      { type: "user", text: "Add a 3 mm spacer under the pen cup." },
      { type: "reasoning", reasoningId: "w-k1", text: "A spacer is a plain block. Spec first, then measure it against the pen cup's base.", status: "done", seconds: 3 },
      { type: "tool", callId: "w1", name: "overview", summary: "overview: 3 parts, assembly draft", status: "ok", result: "tray passed", images: [] },
      { type: "tool", callId: "w2", name: "set_part_spec", summary: "spec spacer", status: "ok", result: "Spec of spacer saved.", images: [] },
      { type: "tool", callId: "w3", name: "evaluate", summary: "measure spacer", status: "ok", result: "Evaluation queued.", images: [] },
      { type: "reasoning", reasoningId: "w-k2", text: "The spacer measures 3.0 mm.\n\nNext: check that the pen cup still sits flat on it, and that the assembly clearance to the tray stays above 1 mm.", status: "running", seconds: 4 },
    ],
    "working",
    40,
    "thinking",
  );
}

function spoolHolder(): void {
  const p = createProject("spool-holder", "Spool holder");
  p.meta.updatedAt = ago(1);
  write(p, "brief.md", "# Spool holder\n\nA wall-mounted holder for a 1 kg spool above the printer.\n", "web");
  write(p, "AGENTS.md", "# Spool holder\n\n- [decision] PLA, quick strictness\n", "agent");
  p.meta.defaults = { material: "PLA", strictness: "quick" };
  seedPart("spool-holder", "spool-arm", { title: "Arm", class: "bracket", dimensions: [{ id: "len", label: "Length", kind: "size", axis: "x", nominal: 90, tol: 0.5 }] }, [{ text: simple("Spool arm", [["length", 90, "60:1:120"], ["width", 12, "8:1:20"], ["thick", 4, "2:0.5:8"]]), message: "arm" }]);
  seedPart("spool-holder", "spool-base", { title: "Wall plate", class: "plate", dimensions: [], prints: [{ revisionId: "r0001", at: ago(1), outcome: "ok", note: "Flat, screws fit." }] }, [{ text: simple("Wall plate", [["width", 60, "40:1:80"], ["depth", 60, "40:1:80"], ["thick", 5, "3:0.5:8"]]), message: "plate" }]);
  seedPart("spool-holder", "spool-axle", { title: "Axle", class: "axle", dimensions: [{ id: "len", label: "Length", kind: "size", axis: "z", min: 65 }] }, [{ text: simple("Spool axle", [["diameter", 30, "20:1:40"], ["length", 70, "50:1:90"]]), message: "axle" }]);
  seedSession(
    "spool-holder",
    "Wall-mounted spool holder",
    [
      { type: "user", text: "A wall-mounted holder for a 1 kg spool above the printer." },
      { type: "tool", callId: "t1", name: "write_model", summary: "spool-arm: passed 5/5", status: "ok", result: "ok", images: [] },
      { type: "tool", callId: "t2", name: "write_model", summary: "spool-axle: passed 5/5", status: "ok", result: "ok", images: [] },
      { type: "assistant", text: "All three parts pass. Print the wall plate first to check the screw holes." },
    ],
    "idle",
    300,
  );
}

function earbuds(): void {
  const p = createProject("earbuds-holder", "Earbuds holder");
  p.meta.description = "A stand for the earbuds case with a cable slot.";
  p.meta.updatedAt = ago(9);
  write(p, "AGENTS.md", "---\ntitle: Earbuds holder\n---\n# Earbuds holder\n\n- [decision] Print in PETG, 0.2 mm layers\n- [measurement] The case is 62 x 48 x 27 mm\n- depends_on [[notes/design]]\n", "agent");
  write(p, "notes/design.md", "# Design\n\nA block with a pocket for the case.\n\n- [measurement] Pocket depth 22 mm\n", "agent");
  write(p, "src/holder.scad", "// Earbuds holder\nsize = 20;\n\ndifference() {\n  cube(size);\n  translate([2, 2, 2]) cube(6);\n}\n", "agent");
  write(p, "refs/cube.stl", cubeStl(20), "import");
  write(p, "refs/reference.png", png(160, 120), "web");
}

/** Nothing but an empty brief: the workspace offers to kick it off. */
function emptyProject(): void {
  const p = createProject("new-idea", "New idea");
  p.meta.updatedAt = ago(0);
  write(p, "brief.md", "# New idea\n\n", "web");
  write(p, "AGENTS.md", "# New idea\n\nProject memory. Read [[brief]] first.\n", "agent");
}

export function seed(): void {
  library();
  emptyProject();
  deskOrganiser();
  spoolHolder();
  earbuds();
}
