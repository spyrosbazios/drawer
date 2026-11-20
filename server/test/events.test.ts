import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DrawerEvent } from "@drawer/shared/api";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

/** Reads data frames from an SSE response. */
function reader(res: Response): { next(): Promise<DrawerEvent>; stop(): Promise<void> } {
  const body = res.body?.getReader();
  if (!body) throw new Error("no body");
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      const deadline = Date.now() + 5000;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6)) as DrawerEvent;
          continue;
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for an event");
        const chunk = await Promise.race([body.read(), Bun.sleep(5000).then(() => null)]);
        if (chunk === null) throw new Error("timed out waiting for an event");
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async stop() {
      await body.cancel();
    },
  };
}

describe("GET /events", () => {
  test("streams project, file and render events", async () => {
    const res = await h.app.fetch(new Request("http://drawer.test/api/events"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = reader(res);

    await h.newProject("ev");
    expect(await events.next()).toEqual({ type: "project", action: "created", slug: "ev" });

    const put = await h.put<{ rev: string }>("/api/projects/ev/files/src/a.scad", "cube(1);", { "x-drawer-author": "web" });
    const rev = put.json.rev;
    expect(await events.next()).toEqual({ type: "file", action: "written", project: "ev", path: "src/a.scad", rev, author: "web" });

    await h.post("/api/projects/ev/edit/src/a.scad", { rev, old: "1", new: "2" });
    const edited = await events.next();
    expect(edited).toMatchObject({ type: "file", action: "written", path: "src/a.scad", author: "agent" });
    expect(edited).not.toEqual({ ...edited, rev });

    await h.post("/api/projects/ev/move", { from: "src/a.scad", to: "src/b.scad" });
    expect(await events.next()).toMatchObject({ type: "file", action: "deleted", path: "src/a.scad", rev: null });
    expect(await events.next()).toMatchObject({ type: "file", action: "moved", path: "src/b.scad" });

    const render = await h.post<{ key: string }>("/api/projects/ev/render/src/b.scad", { views: ["iso"] });
    const progress = { type: "render_progress", project: "ev", path: "src/b.scad", at: null, total: 4, view: null } as const;
    expect(await events.next()).toEqual({ ...progress, stage: "queued", step: 0 });
    expect(await events.next()).toEqual({ ...progress, stage: "geometry", step: 1 });
    expect(await events.next()).toEqual({ ...progress, stage: "done", step: 4 });
    expect(await events.next()).toEqual({ type: "render", project: "ev", path: "src/b.scad", key: render.json.key });

    const current = (await h.get("/api/projects/ev/files/src/b.scad")).headers.get("x-drawer-rev") as string;
    await h.del("/api/projects/ev/files/src/b.scad", { "x-drawer-rev": current });
    expect(await events.next()).toMatchObject({ type: "file", action: "deleted", path: "src/b.scad", rev: null });

    await h.call("PATCH", "/api/projects/ev", { body: { title: "Ev" } });
    expect(await events.next()).toEqual({ type: "project", action: "updated", slug: "ev" });
    await h.del("/api/projects/ev");
    expect(await events.next()).toEqual({ type: "project", action: "deleted", slug: "ev" });
    await events.stop();
  });

  test("a failed write and a no-op write emit nothing", async () => {
    await h.newProject("quiet");
    const res = await h.app.fetch(new Request("http://drawer.test/api/events"));
    const events = reader(res);
    const rev = await h.write("quiet", "notes/a.md", "same");
    expect(await events.next()).toMatchObject({ type: "file", path: "notes/a.md" });
    await h.put("/api/projects/quiet/files/notes/a.md", "different", { "x-drawer-rev": "ffffffffffffffff" }); // conflict
    await h.put("/api/projects/quiet/files/notes/a.md", "same", { "x-drawer-rev": rev }); // identical bytes
    await h.write("quiet", "notes/b.md", "marker");
    expect(await events.next()).toMatchObject({ type: "file", path: "notes/b.md" });
    await events.stop();
  });

  test("close() ends open streams", async () => {
    const h2 = await harness();
    const res = await h2.app.fetch(new Request("http://drawer.test/api/events"));
    const body = res.body?.getReader();
    await h2.close();
    // after close the stream is finished rather than hanging
    let finished = false;
    for (let i = 0; i < 5 && !finished; i++) finished = (await body?.read())?.done ?? true;
    expect(finished).toBe(true);
  });
});
