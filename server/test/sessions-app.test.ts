import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FileAttachmentResult, RunnerWork, Session, SessionAttachment, SessionDetail, SessionsResponse, TreeResponse } from "@drawer/shared/api";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("hook");
});
afterAll(async () => {
  await h.close();
});

describe("sessions in the real app", () => {
  test("/guide serves the modelling guide as markdown", async () => {
    const res = await h.get("/api/guide");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.text).toContain("# Modelling guide");
  });

  test("a session starts on an existing project only, and a runner turn carries the guide", async () => {
    expect((await h.post("/api/projects/nope/sessions", { message: "hi" })).status).toBe(404);
    expect((await h.post("/api/projects/hook/sessions", { message: "" })).status).toBe(400);

    const created = await h.post<Session>("/api/projects/hook/sessions", { message: "Make a hook" });
    expect(created.status).toBe(201);
    const providers = [{ kind: "claude", state: "ready", version: null, models: [], message: null, binary: null }];
    const work = await h.post<RunnerWork>("/api/runner/work", { runner: "app-test", boot: "b1", providers, accepting: true, wait: 1 });
    expect(work.json).toMatchObject({ kind: "turn", session: { id: created.json.id, status: "working" } });
    expect(work.json !== null && work.json.kind === "turn" ? work.json.guide : "").toBe((await h.get("/api/guide")).text);
  });

  test("deleting a project deletes its sessions", async () => {
    await h.newProject("gone");
    const created = await h.post<Session>("/api/projects/gone/sessions", { message: "doomed" });
    expect((await h.get<SessionsResponse>("/api/sessions?project=gone")).json.sessions.map((s) => s.id)).toEqual([created.json.id]);
    expect((await h.del("/api/projects/gone")).status).toBe(204);
    expect((await h.get<SessionsResponse>("/api/sessions?project=gone")).json.sessions).toEqual([]);
    expect((await h.get(`/api/sessions/${created.json.id}`)).status).toBe(404);
    // The other project's sessions stay.
    expect((await h.get<SessionsResponse>("/api/sessions?project=hook")).json.sessions.length).toBe(1);
  });

  test("attachments: upload, send with a message, serve, file into the project", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const up = await h.call<SessionAttachment>("POST", "/api/projects/hook/attachments?name=" + encodeURIComponent("dir/../Photo 1.png"), { raw: png });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ name: "Photo 1.png", mediaType: "image/png", size: png.length, kind: "image", filedAs: null });
    expect(up.json.url).toBe(`/api/attachments/${up.json.id}`);
    const stl = await h.call<SessionAttachment>("POST", "/api/projects/hook/attachments?name=thing.stl", { raw: "solid x\nendsolid x\n" });
    const odd = await h.call<SessionAttachment>("POST", "/api/projects/hook/attachments?name=notes.unknownext", { raw: "plain words" });
    expect(odd.json).toMatchObject({ kind: "text", mediaType: "text/plain; charset=utf-8" });
    expect((await h.call("POST", "/api/projects/nope/attachments?name=a.png", { raw: png })).status).toBe(404);
    expect((await h.call("POST", "/api/projects/hook/attachments", { raw: png })).status).toBe(400);
    expect((await h.call("POST", "/api/projects/hook/attachments?name=empty.bin", { raw: new Uint8Array() })).status).toBe(400);

    // A message may be only attachments; an id goes with one message only, and only in its project.
    const created = await h.post<Session>("/api/projects/hook/sessions", { message: "", attachments: [up.json.id, stl.json.id] });
    expect(created.status).toBe(201);
    expect(created.json.title).toBe("Photo 1.png");
    expect((await h.post("/api/projects/hook/sessions", { message: "again", attachments: [up.json.id] })).status).toBe(400);
    expect((await h.post(`/api/sessions/${created.json.id}/messages`, { text: "x", attachments: ["0123456789abcdef"] })).status).toBe(400);
    await h.newProject("other");
    const elsewhere = await h.call<SessionAttachment>("POST", "/api/projects/other/attachments?name=a.txt", { raw: "a" });
    expect((await h.post(`/api/sessions/${created.json.id}/messages`, { text: "x", attachments: [elsewhere.json.id] })).status).toBe(400);
    expect((await h.post(`/api/sessions/${created.json.id}/messages`, { text: "" })).status).toBe(400);

    const detail = await h.get<SessionDetail>(`/api/sessions/${created.json.id}`);
    const item = detail.json.items[0];
    expect(item?.type === "user" ? item.attachments.map((a) => a.id) : []).toEqual([up.json.id, stl.json.id]);

    const bytes = await h.get(`/api/attachments/${up.json.id}?download=1`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(bytes.headers.get("content-disposition")).toContain("Photo 1.png");
    expect([...bytes.bytes]).toEqual([...png]);
    expect((await h.get("/api/attachments/ffffffffffffffff")).status).toBe(404);

    // Filing writes one revision through the normal write path and marks the message's attachment.
    const filed = await h.post<FileAttachmentResult>(`/api/attachments/${stl.json.id}/file`, { path: "refs/thing.stl" }, { "x-drawer-author": "agent" });
    expect(filed.status).toBe(200);
    expect(filed.json.write).toMatchObject({ path: "refs/thing.stl", created: true });
    expect(filed.json.attachment.filedAs).toBe("refs/thing.stl");
    const tree = await h.get<TreeResponse>("/api/projects/hook/tree");
    expect(tree.json.entries.find((e) => e.path === "refs/thing.stl")).toMatchObject({ kind: "mesh", updatedBy: "agent" });
    const history = await h.get<{ revisions: { message: string; author: string }[] }>("/api/projects/hook/history?path=refs/thing.stl");
    expect(history.json.revisions[0]).toMatchObject({ author: "agent", message: `file thing.stl from session ${created.json.id}` });
    // Again without a rev: the path exists now.
    expect((await h.post(`/api/attachments/${stl.json.id}/file`, { path: "refs/thing.stl" })).status).toBe(409);
    expect((await h.post(`/api/attachments/${stl.json.id}/file`, { path: "../x.stl" })).status).toBe(400);

    const after = await h.get<SessionDetail>(`/api/sessions/${created.json.id}?since=${detail.json.session.version}`);
    const changed = after.json.items[0];
    expect(changed?.type === "user" ? changed.attachments.map((a) => a.filedAs) : []).toEqual([null, "refs/thing.stl"]);

    // Deleting the session deletes its attachments.
    expect((await h.del(`/api/sessions/${created.json.id}`)).status).toBe(204);
    expect((await h.get(`/api/attachments/${up.json.id}`)).status).toBe(404);
    expect((await h.get(`/api/attachments/${odd.json.id}`)).status).toBe(200);
  });
});
