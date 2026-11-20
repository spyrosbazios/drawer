import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harness, TEST_HOST, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await mkdir(join(h.webDist, "assets"), { recursive: true });
  await writeFile(join(h.webDist, "index.html"), "<!doctype html><title>drawer</title>");
  await writeFile(join(h.webDist, "assets", "app.js"), "console.log(1)");
});
afterAll(async () => {
  await h.close();
});

describe("static web app", () => {
  test("serves index.html at / and as the SPA fallback", async () => {
    for (const path of ["/", "/projects/x/notes/a.md", "/assets/missing.js-not-here"]) {
      const res = await h.get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain("<title>drawer</title>");
    }
  });

  test("serves built assets with immutable caching", async () => {
    const res = await h.get("/assets/app.js");
    expect(res.text).toBe("console.log(1)");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("cannot escape the dist folder", async () => {
    for (const path of ["/..%2f..%2fdata%2findex.db", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2f..%2fdata%2findex.db"]) {
      const res = await h.get(path);
      expect(res.text).toContain("<title>drawer</title>");
    }
  });

  test("unknown /api routes are JSON 404s, not the SPA", async () => {
    const res = await h.get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "not_found" });
    expect((await h.call("DELETE", "/api/health")).status).toBe(400);
  });
});

/** A request to the harness app as a browser or a client at `origin` would send it. */
async function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Response> {
  return h.app.fetch(new Request(`http://${TEST_HOST}${path}`, { method, headers, body }));
}

describe("no CORS", () => {
  test("no response carries an access-control header, and OPTIONS is not special", async () => {
    const responses = [
      await send("OPTIONS", "/api/projects/x/files/a.md", { origin: "http://localhost:5173", "access-control-request-method": "PUT" }),
      await send("GET", "/api/health", { origin: "https://evil.example" }),
      await send("GET", "/api/projects/nope", { origin: "https://evil.example" }),
      await send("POST", "/api/projects", { origin: "https://evil.example", "content-type": "application/json" }, "{}"),
      await send("GET", "/", {}),
    ];
    // A preflight from elsewhere is just a refused cross-origin request now.
    expect(responses[0]?.status).toBe(403);
    for (const res of responses) {
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("cross-site requests", () => {
  const json = { "content-type": "application/json" };

  test("a cross-origin POST, PUT, PATCH or DELETE is refused before it does anything", async () => {
    await h.newProject("victim");
    const evil = { origin: "https://evil.example" };
    const attempts = [
      await send("POST", "/api/projects", { ...evil, ...json }, JSON.stringify({ slug: "planted" })),
      await send("PUT", "/api/projects/victim/files/x.md", { ...evil, "x-drawer-rev": "*" }, "planted"),
      await send("PATCH", "/api/projects/victim", { ...evil, ...json }, JSON.stringify({ title: "planted" })),
      await send("DELETE", "/api/projects/victim", evil),
      await send("POST", "/api/projects/victim/attachments?name=a.txt", evil, "planted"),
      await send("POST", "/api/projects", { origin: "null", ...json }, JSON.stringify({ slug: "planted" })),
      await send("POST", "/api/projects", { "sec-fetch-site": "cross-site", ...json }, JSON.stringify({ slug: "planted" })),
      // Another port is another origin.
      await send("DELETE", "/api/projects/victim", { origin: `http://${TEST_HOST}:8080` }),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
    expect((await h.get("/api/projects/victim")).status).toBe(200);
    expect((await h.get("/api/projects/victim/files/x.md")).status).toBe(404);
    expect((await h.get("/api/projects/planted")).status).toBe(404);
  });

  test("a same-origin write and a client without Origin both work; GETs are not checked", async () => {
    const same = await send("POST", "/api/projects", { origin: `http://${TEST_HOST}`, "sec-fetch-site": "same-origin", ...json }, JSON.stringify({ slug: "mine" }));
    expect(same.status).toBe(201);
    // TLS ending at a reverse proxy: the scheme differs, host and port match.
    const proxied = await send("PUT", "/api/projects/mine/files/a.md", { origin: `https://${TEST_HOST}`, "x-drawer-rev": "*" }, "hello");
    expect(proxied.status).toBe(200);
    const { rev } = (await proxied.json()) as { rev: string };
    expect((await send("DELETE", "/api/projects/mine/files/a.md", { "x-drawer-rev": rev })).status).toBe(200);
    expect((await send("GET", "/api/projects/mine", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(200);
  });

  test("a JSON route refuses a body that is not declared application/json", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await send("POST", "/api/projects", { "content-type": type }, JSON.stringify({ slug: "sneaky" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain("application/json");
    }
    expect((await send("POST", "/api/projects", {}, JSON.stringify({ slug: "sneaky" }))).status).toBe(400);
    expect((await send("POST", "/api/projects", { "content-type": "Application/JSON; charset=utf-8" }, JSON.stringify({ slug: "typed" }))).status).toBe(201);
  });
});

describe("DNS rebinding", () => {
  const at = (host: string, path = "/api/health"): Promise<Response> => h.app.fetch(new Request(`http://127.0.0.1${path}`, { headers: { host } }));

  test("a host name nobody allowed is refused, with the variable to set", async () => {
    for (const host of ["evil.example", "evil.example:3050", "drawer.test.evil.example", "localhost.evil.example"]) {
      const res = await at(host);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("DRAWER_ALLOWED_HOSTS=");
    }
    // The web app is guarded too: a rebound page could otherwise read it.
    expect((await at("evil.example", "/")).status).toBe(403);
    for (const host of ["", "a b", "x@y", "x/y"]) expect((await at(host)).status).toBe(403);
  });

  test("IP literals, localhost and allowed names are served", async () => {
    for (const host of ["127.0.0.1", "127.0.0.1:3050", "100.64.1.2:3050", "[::1]:3050", "[fd00::1]", "localhost", "LOCALHOST:5173", TEST_HOST, `${TEST_HOST.toUpperCase()}:3050`, `${TEST_HOST}.`]) {
      expect({ host, status: (await at(host)).status }).toEqual({ host, status: 200 });
    }
  });
});

describe("bodies", () => {
  test("invalid JSON and wrong types are 400", async () => {
    expect((await h.call("POST", "/api/projects", { raw: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await h.post("/api/projects", { slug: 5 })).status).toBe(400);
    expect((await h.post("/api/projects", { slug: "ok-slug", title: 5 })).status).toBe(400);
    expect((await h.call("POST", "/api/projects", { raw: "[]" })).status).toBe(400);
  });
});
