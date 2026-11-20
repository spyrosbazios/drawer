import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportError } from "@drawer/shared/contracts";
import { createImporters } from "../src/index";
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, createHttp, pinnedRequest } from "../src/http";
import { bytesResponse, jsonResponse, mockEnv, publicResolve } from "./helpers";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawer-importers-http-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("retries", () => {
  test("429 and 5xx are retried twice with growing waits, then the last answer is used", async () => {
    const waits: number[] = [];
    let n = 0;
    const http = createHttp({
      resolve: publicResolve,
      fetch: async () => {
        n++;
        return new Response("", { status: 503 });
      },
      sleep: async (ms) => void waits.push(ms),
      backoffMs: 100,
    });
    const res = await http.request("https://example.org/", { label: "Example" });
    expect(res.status).toBe(503);
    expect(n).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  test("a retry that succeeds ends the loop; Retry-After is honoured", async () => {
    const waits: number[] = [];
    let n = 0;
    const http = createHttp({
      resolve: publicResolve,
      fetch: async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : jsonResponse({ ok: 1 })),
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await http.json("https://example.org/", { label: "Example" })).toEqual({ ok: 1 });
    expect(n).toBe(2);
    expect(waits).toEqual([2000]);
  });

  test("4xx is not retried; network errors are, and become ImportError without the URL", async () => {
    const calls: string[] = [];
    const http = createHttp({
      resolve: publicResolve,
      fetch: async (url) => {
        calls.push(url);
        return new Response("", { status: 404 });
      },
      sleep: async () => {},
    });
    expect((await http.request("https://example.org/", { label: "Example" })).status).toBe(404);
    expect(calls).toHaveLength(1);

    let tries = 0;
    const down = createHttp({
      resolve: publicResolve,
      fetch: async (url) => {
        tries++;
        throw new TypeError(`unable to connect to ${url}`);
      },
      sleep: async () => {},
    });
    const err = await down.request("https://example.org/?key=secret", { label: "Example" }).catch((e: unknown) => e);
    expect(tries).toBe(3);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toBe("Example is unreachable (network error)");
  });

  test("non-JSON and HTTP errors are ImportErrors", async () => {
    const http = createHttp({ resolve: publicResolve, fetch: async () => new Response("<html>", { status: 200 }), sleep: async () => {} });
    await expect(http.json("https://example.org/", { label: "Example" })).rejects.toThrow("did not answer with JSON");
    const bad = createHttp({ resolve: publicResolve, fetch: async () => new Response("", { status: 418 }), sleep: async () => {} });
    await expect(bad.json("https://example.org/", { label: "Example" })).rejects.toThrow("Example answered HTTP 418");
  });
});

describe("redirects", () => {
  test("credentials stay on their own origin; a 303 turns into a GET", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const http = createHttp({
      resolve: publicResolve,
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string> });
        if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/next" } });
        if (calls.length === 2) return new Response(null, { status: 303, headers: { location: "https://cdn.example.net/f" } });
        return new Response("ok");
      },
      sleep: async () => {},
    });
    const res = await http.request("https://api.example.org/start", {
      label: "Example",
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(await res.text()).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual(["https://api.example.org/start", "https://api.example.org/next", "https://cdn.example.net/f"]);
    expect(calls[1]?.headers.authorization).toBe("Bearer t");
    expect(calls[2]?.method).toBe("GET");
    expect(calls[2]?.headers.authorization).toBeUndefined();
    expect(calls[2]?.headers["content-type"]).toBeUndefined();
  });

  test("redirect loops and non-http targets are refused", async () => {
    const loop = createHttp({ resolve: publicResolve, fetch: async () => new Response(null, { status: 302, headers: { location: "/again" } }), sleep: async () => {} });
    await expect(loop.request("https://example.org/", { label: "Example" })).rejects.toThrow("too many times");
    const file = createHttp({ resolve: publicResolve, fetch: async () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }), sleep: async () => {} });
    await expect(file.request("https://example.org/", { label: "Example" })).rejects.toThrow("unsupported address");
  });
});

describe("downloads (real sockets on localhost, plus the 200 MB cap)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let other: ReturnType<typeof Bun.serve>;
  const seenAuth: Array<string | null> = [];

  beforeAll(() => {
    other = Bun.serve({
      port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization"));
        return new Response("from the cdn", { headers: { "content-type": "application/octet-stream" } });
      },
    });
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/small") return new Response("hello", { headers: { "content-type": "application/octet-stream" } });
        if (path === "/redirect") {
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/file` } });
        }
        if (path === "/missing") return new Response("no", { status: 404 });
        if (path === "/page") return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
        if (path === "/stream-big") {
          // No content-length: only the running count can catch this one.
          const chunk = new Uint8Array(1024 * 1024);
          let sent = 0;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (sent > 25) return controller.close();
                sent++;
                controller.enqueue(chunk);
              },
            }),
            { headers: { "content-type": "image/png" } },
          );
        }
        return new Response("?", { status: 500 });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    other.stop(true);
  });

  const base = () => `http://127.0.0.1:${server.port}`;
  // The address policy refuses loopback; these tests talk to a local server on purpose.
  const local = { isPublic: () => true, sleep: async () => {} };
  const http = () => createHttp(local);
  const opts = { label: "Test host", maxBytes: 1024, kind: "file" as const };

  test("streams to a path whose parent directories do not exist", async () => {
    const dest = join(dir, "a", "b", "c.bin");
    await http().download(`${base()}/small`, opts, dest);
    expect(await readFile(dest, "utf8")).toBe("hello");
  });

  test("follows a redirect to another origin without the bearer", async () => {
    const dest = join(dir, "r.bin");
    await http().download(`${base()}/redirect`, { ...opts, headers: { authorization: "Bearer secret" } }, dest);
    expect(await readFile(dest, "utf8")).toBe("from the cdn");
    expect(seenAuth.at(-1)).toBeNull();
  });

  test("HTTP errors and web pages in place of files are ImportErrors and leave nothing behind", async () => {
    await expect(http().download(`${base()}/missing`, opts, join(dir, "m"))).rejects.toThrow("Test host answered HTTP 404");
    await expect(http().download(`${base()}/page`, opts, join(dir, "p"))).rejects.toThrow("web page instead of the file");
    expect(await stat(join(dir, "m")).catch(() => null)).toBeNull();
    expect(await stat(join(dir, "p")).catch(() => null)).toBeNull();
  });

  test("the 200 MB cap: declared size is refused up front", async () => {
    const declared = createHttp({
      resolve: publicResolve,
      fetch: async () => new Response("x", { headers: { "content-length": String(MAX_FILE_BYTES + 1), "content-type": "application/octet-stream" } }),
      sleep: async () => {},
    });
    const err = await declared.download("https://example.org/big", { ...opts, maxBytes: MAX_FILE_BYTES }, join(dir, "big")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toBe("File is larger than the 200 MB limit");
    expect(await stat(join(dir, "big")).catch(() => null)).toBeNull();
  });

  test("the 20 MB image cap: a stream without content-length is cut off and the partial file removed", async () => {
    const dest = join(dir, "img.png");
    const importers = createImporters({}, local);
    const err = await importers.downloadImage(`${base()}/stream-big`, dest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toBe("Image is larger than the 20 MB limit");
    expect(await stat(dest).catch(() => null)).toBeNull();
  });

  test("an image under the cap is saved", async () => {
    const dest = join(dir, "i", "ok.png");
    await createImporters({}, local).downloadImage(`${base()}/small`, dest);
    expect((await stat(dest)).size).toBe(5);
  });

  test("the caps are the documented ones", () => {
    expect(MAX_FILE_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("downloadImage through the mock", () => {
  test("rejects non-http addresses", async () => {
    const { env } = mockEnv(() => bytesResponse("x"));
    await expect(createImporters({}, env).downloadImage("file:///etc/passwd", join(dir, "x"))).rejects.toThrow("http and https");
  });
});

describe("the address policy on every hop", () => {
  function recording(resolveTo: Record<string, string[]>, answer: (url: string) => Response = () => new Response("ok")) {
    const fetched: Array<{ url: string; address: string }> = [];
    const resolved: string[] = [];
    const http = createHttp({
      resolve: async (name) => {
        resolved.push(name);
        const out = resolveTo[name];
        if (out === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
        return out;
      },
      fetch: async (url, _init, address) => {
        fetched.push({ url, address });
        return answer(url);
      },
      sleep: async () => {},
    });
    return { http, fetched, resolved };
  }

  test("a private IP literal is refused without a request, and the message names no URL", async () => {
    const { http, fetched } = recording({});
    for (const url of ["http://127.0.0.1:3050/api/projects", "http://169.254.169.254/latest/meta-data/?token=x", "http://[::ffff:7f00:1]/", "http://localhost/", "http://0x7f.1/"]) {
      const err = await http.request(url, { label: "Web page" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as Error).message).toBe("Web page refused: the address is not public");
    }
    expect(fetched).toEqual([]);
  });

  test("a name is refused when any of its addresses is not public", async () => {
    const { http, fetched } = recording({ "mixed.example": ["93.184.215.14", "10.0.0.5"], "inner.example": ["fd7a:115c:a1e0::1"] });
    await expect(http.request("https://mixed.example/", { label: "Web page" })).rejects.toThrow("refused: the address is not public");
    await expect(http.request("https://inner.example/", { label: "Web page" })).rejects.toThrow("refused: the address is not public");
    expect(fetched).toEqual([]);
  });

  test("the request is pinned to the address that was checked", async () => {
    const { http, fetched, resolved } = recording({ "site.example": ["93.184.215.14", "2606:4700::1"] });
    await http.request("https://site.example/a", { label: "Web page" });
    expect(resolved).toEqual(["site.example"]);
    expect(fetched).toEqual([{ url: "https://site.example/a", address: "93.184.215.14" }]);
  });

  test("a redirect to a private address or to localhost is refused before it is fetched", async () => {
    for (const location of ["http://192.168.1.1/admin", "http://localhost:3050/api/projects", "https://rebind.example/"]) {
      const { http, fetched } = recording({ "site.example": ["93.184.215.14"], "rebind.example": ["127.0.0.1"] }, (url) =>
        url.startsWith("https://site.example") ? new Response(null, { status: 302, headers: { location } }) : new Response("secret"),
      );
      await expect(http.request("https://site.example/", { label: "Web page" })).rejects.toThrow("Web page refused: the address is not public");
      expect(fetched.map((f) => f.url)).toEqual(["https://site.example/"]);
    }
  });

  test("an unknown name is unreachable, not refused", async () => {
    const { http } = recording({});
    await expect(http.request("https://nowhere.example/", { label: "Web page" })).rejects.toThrow("Web page is unreachable (ENOTFOUND)");
  });

  test("sameOrigin: a redirect to another origin is never followed", async () => {
    const { http, fetched } = recording({ "api.example": ["93.184.215.14"], "elsewhere.example": ["93.184.215.15"] }, (url) =>
      url.includes("/v2/") ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example/collect" } }) : new Response(null, { status: 302, headers: { location: "/v2/x?key=k" } }),
    );
    const err = await http.request("https://api.example/v1/x?key=k", { label: "MyMiniFactory", sameOrigin: true }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("MyMiniFactory redirected to another site, which is not followed for this request");
    expect(fetched.map((f) => f.url)).toEqual(["https://api.example/v1/x?key=k", "https://api.example/v2/x?key=k"]);
  });
});

describe("pinned connections (real sockets)", () => {
  test("http: connects to the checked address and sends the original Host", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(req.headers.get("host") ?? "");
        return new Response("pinned");
      },
    });
    try {
      // The name does not exist in DNS: only the pin can get the request to the server.
      const http = createHttp({ resolve: async () => ["127.0.0.1"], isPublic: () => true, sleep: async () => {} });
      const res = await http.request(`http://files.drawer-test.invalid:${server.port}/x`, { label: "Test host" });
      expect(await res.text()).toBe("pinned");
      expect(seen).toEqual([`files.drawer-test.invalid:${server.port}`]);
    } finally {
      server.stop(true);
    }
  });

  test("https: SNI and the certificate are checked against the name, not the pinned IP", async () => {
    const openssl = Bun.which("openssl");
    if (openssl === null) return;
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const made = Bun.spawnSync([openssl, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=pinned.test", "-addext", "subjectAltName=DNS:pinned.test"], { stderr: "ignore" });
    expect(made.exitCode).toBe(0);
    const cert = await readFile(certPath, "utf8");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { key: await readFile(keyPath, "utf8"), cert }, fetch: () => new Response("tls ok") });
    try {
      // The production request plus the test CA; nothing else is changed.
      const viaPin = async (host: string): Promise<string> => {
        const pinned = pinnedRequest(`https://${host}:${server.port}/`, { redirect: "manual" }, "127.0.0.1");
        expect(new URL(pinned.url).hostname).toBe("127.0.0.1");
        const tls = (pinned.init as { tls?: Record<string, unknown> }).tls;
        const res = await fetch(pinned.url, { ...pinned.init, tls: { ...tls, ca: cert } } as RequestInit);
        return res.text();
      };
      expect(await viaPin("pinned.test")).toBe("tls ok");
      const wrong = await viaPin("other.test").catch((e: unknown) => e);
      expect((wrong as { code?: string }).code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      // Without the test CA the chain is still verified.
      const pinned = pinnedRequest(`https://pinned.test:${server.port}/`, {}, "127.0.0.1");
      const untrusted = await fetch(pinned.url, pinned.init).catch((e: unknown) => e);
      expect(untrusted).toBeInstanceOf(Error);
    } finally {
      server.stop(true);
    }
  });
});
