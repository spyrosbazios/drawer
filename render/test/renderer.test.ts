/** Renderer behaviour that needs no real OpenSCAD: a fake `openscad` shell script stands in. */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderError } from "@drawer/shared/contracts";
import { createRenderer } from "../src/index";

async function fakeOpenscad(dir: string, body: string): Promise<string> {
  const path = join(dir, "fake-openscad");
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "OpenSCAD version 0.0.0-fake" >&2; exit 0; fi\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function setup(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "drawer-render-fake-"));
  const scad = join(dir, "part.scad");
  await writeFile(scad, "cube(10);\n");
  const cmd = await fakeOpenscad(dir, body.replaceAll("$DIR", dir));
  return { dir, scad, cacheDir: join(dir, "cache"), cmd };
}

/** Running, not merely an unreaped zombie (as when the test itself is PID 1 in a container). */
async function alive(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat !== null && !/^\d+ \(.*\) Z/.test(stat);
}

describe("renderer without real OpenSCAD", () => {
  test("version() is null when the command cannot run, and render() throws RenderError", async () => {
    const r = createRenderer({ cacheDir: join(tmpdir(), "drawer-unused"), openscadCmd: "/nonexistent/openscad" });
    expect(await r.version()).toBeNull();
    await expect(r.render({ file: "/x.scad", searchPaths: [], views: ["iso"], size: 100 })).rejects.toBeInstanceOf(RenderError);
  });

  test("version() parses the version and is cached", async () => {
    const { cmd, cacheDir } = await setup("exit 1");
    const r = createRenderer({ cacheDir, openscadCmd: cmd });
    expect(await r.version()).toBe("0.0.0-fake");
    expect(r.version()).toBe(r.version());
  });

  test("timeout kills the whole process group and throws RenderError with stderr", async () => {
    const { dir, scad, cacheDir, cmd } = await setup('echo "ERROR: fake hang" >&2\nsleep 30 &\necho $! > "$DIR/sleep.pid"\nwait');
    const r = createRenderer({ cacheDir, openscadCmd: cmd, timeoutSeconds: 1 });
    const started = Date.now();
    const err = await r.render({ file: scad, searchPaths: [dir], views: ["iso"], size: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as Error).message).toContain("timed out after 1 s");
    expect((err as Error).message).toContain("ERROR: fake hang");
    expect(Date.now() - started).toBeLessThan(5000);
    const sleepPid = Number((await readFile(join(dir, "sleep.pid"), "utf8")).trim());
    for (let i = 0; i < 50 && (await alive(sleepPid)); i++) await Bun.sleep(20);
    expect(await alive(sleepPid)).toBe(false);
    // The temp dir is cleaned up and nothing was published.
    expect(await readdir(cacheDir)).toEqual([]);
  });

  test("a failing OpenSCAD run surfaces its messages", async () => {
    // Echo export writes messages into the -o file; mimic that.
    const { scad, cacheDir, cmd } = await setup('echo "ERROR: Parser error: syntax error in file part.scad, line 2" > "$2"\nexit 1');
    const r = createRenderer({ cacheDir, openscadCmd: cmd });
    await expect(r.render({ file: scad, searchPaths: [], views: ["iso"], size: 100 })).rejects.toThrow("Parser error: syntax error");
  });

  test("rejects unsupported files and bad requests", async () => {
    const { dir, cacheDir, cmd } = await setup("exit 1");
    await mkdir(join(dir, "d"), { recursive: true });
    await writeFile(join(dir, "d", "notes.md"), "# hi");
    const r = createRenderer({ cacheDir, openscadCmd: cmd });
    await expect(r.render({ file: join(dir, "d", "notes.md"), searchPaths: [], views: ["iso"], size: 100 })).rejects.toThrow("only .scad");
    await expect(r.render({ file: join(dir, "part.scad"), searchPaths: [], views: [], size: 100 })).rejects.toThrow("no views");
    await expect(r.render({ file: join(dir, "part.scad"), searchPaths: [], views: ["iso"], size: 0 })).rejects.toThrow("size");
  });
});
