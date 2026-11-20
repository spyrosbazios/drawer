/** Each site's response-to-ImportPreview mapping against small fixtures shaped like the real responses. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportError } from "@drawer/shared/contracts";
import { createImporters } from "../src/index";
import { bytesResponse, htmlResponse, jsonResponse, mockEnv } from "./helpers";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawer-importers-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BOT_PAGE = "<html><title>Just a moment...</title></html>";

describe("printables", () => {
  const modelUrl = "https://www.printables.com/model/642560-apple-earpods";
  // Shape of the live response for model 642560.
  const model = {
    id: "642560",
    name: "Apple earpods / earbuds holder, wrap (USB-C) ",
    slug: "apple-earpods",
    summary: "A remix of the Lightning connector version.",
    description: "<p>Print it in <strong>PETG</strong>.</p><script>x()</script>",
    user: { id: "136327", handle: "Someone_136327", publicUsername: "Someone" },
    license: { id: "7", name: "Creative Commons — Public Domain", abbreviation: "CC0" },
    tags: [{ name: "apple" }, { name: "headphones" }, { name: "apple" }],
    images: [{ filePath: "media/prints/642560/images/a/earbud.jpeg" }, { filePath: "media/prints/642560/images/b/screen.png" }],
    stls: [{ id: "2707023", name: "earbud safe usb-c.stl", fileSize: 90584, folder: "" }],
    otherFiles: [{ id: "55", name: "notes.pdf", fileSize: 1200, folder: "" }],
  };

  test("maps a model", async () => {
    const { env, calls } = mockEnv(() => jsonResponse({ data: { model } }));
    const preview = await createImporters({}, env).preview(modelUrl);
    expect(preview).toEqual({
      source: {
        site: "printables",
        url: modelUrl,
        title: "Apple earpods / earbuds holder, wrap (USB-C)",
        author: "Someone",
        license: "Creative Commons — Public Domain",
        description: "A remix of the Lightning connector version.\n\nPrint it in **PETG**.",
        images: [
          "https://media.printables.com/media/prints/642560/images/a/earbud.jpeg",
          "https://media.printables.com/media/prints/642560/images/b/screen.png",
        ],
      },
      files: [
        { id: "stl:2707023", name: "earbud safe usb-c.stl", size: 90584, downloadable: true },
        { id: "other:55", name: "notes.pdf", size: 1200, downloadable: true },
      ],
      blocker: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.printables.com/graphql/");
    expect(JSON.parse(calls[0]!.body!).variables).toEqual({ id: "642560" });
    expect(calls[0]?.headers["user-agent"]).toBe("drawer-importer/0.1");
  });

  test("a missing model is an ImportError", async () => {
    const { env } = mockEnv(() => jsonResponse({ data: { model: null } }));
    await expect(createImporters({}, env).preview(modelUrl)).rejects.toThrow("no such model");
  });

  test("GraphQL errors surface as ImportError", async () => {
    const { env } = mockEnv(() => jsonResponse({ errors: [{ message: "boom" }], data: null }));
    await expect(createImporters({}, env).preview(modelUrl)).rejects.toThrow("Printables API error: boom");
  });

  test("download asks for a link, then streams the file", async () => {
    const link = "https://files.printables.com/media/prints/642560/stls/x/earbud.stl";
    const { env, calls } = mockEnv((call) => {
      if (call.url.startsWith("https://api.printables.com")) {
        return jsonResponse({ data: { result: { ok: true, errors: null, output: { link, ttl: 86400 } } } });
      }
      return bytesResponse("solid cube\nendsolid cube\n");
    });
    const dest = join(dir, "refs", "x", "earbud.stl");
    await createImporters({}, env).download(modelUrl, { id: "stl:2707023", name: "earbud.stl", size: null, downloadable: true }, dest);
    expect(await readFile(dest, "utf8")).toBe("solid cube\nendsolid cube\n");
    expect(JSON.parse(calls[0]!.body!).variables).toEqual({ id: "2707023", modelId: "642560", fileType: "stl" });
    expect(calls[1]?.url).toBe(link);
  });

  test("download reports a refused link in plain words", async () => {
    const { env } = mockEnv(() => jsonResponse({ data: { result: { ok: false, errors: [{ field: "id", messages: ["Not found"] }], output: null } } }));
    await expect(
      createImporters({}, env).download(modelUrl, { id: "stl:1", name: "a.stl", size: null, downloadable: true }, join(dir, "a.stl")),
    ).rejects.toThrow("did not give a download link: Not found");
  });

  test("download rejects a file id from another site", async () => {
    const { env } = mockEnv(() => jsonResponse({}));
    await expect(
      createImporters({}, env).download(modelUrl, { id: "12", name: "a.stl", size: null, downloadable: true }, join(dir, "a.stl")),
    ).rejects.toThrow("Unknown Printables file id");
  });
});

describe("thingiverse", () => {
  const url = "https://www.thingiverse.com/thing:4932";
  const thing = {
    id: 4932,
    name: "Ultrasonic scanning sensor test platform",
    description: "Test platform for **ultrasonic** sensors.",
    details: "<p>Details here.</p>",
    instructions: "<ul><li>0.2 mm layers</li></ul>",
    license: "Creative Commons - Attribution",
    creator: { name: "ng433", first_name: "N" },
    tags: [{ name: "sensor", tag: "sensor" }, { name: "robot", tag: "robot" }],
    default_image: { url: "https://cdn.thingiverse.com/default.jpg", sizes: [] },
  };
  const files = [
    { id: 111, name: "base.stl", size: 2048, download_url: "https://api.thingiverse.com/files/111/download" },
    { id: 112, name: "lid/top.stl", size: 1024 },
  ];
  const images = [
    {
      id: 1,
      url: "https://cdn.thingiverse.com/one.jpg",
      sizes: [
        { type: "thumb", size: "large", url: "https://cdn.thingiverse.com/one_thumb.jpg" },
        { type: "display", size: "medium", url: "https://cdn.thingiverse.com/one_display_m.jpg" },
        { type: "display", size: "large", url: "https://cdn.thingiverse.com/one_display_l.jpg" },
      ],
    },
    { id: 2, url: "https://cdn.thingiverse.com/two.jpg", sizes: [] },
  ];

  function api(call: { url: string }) {
    if (call.url.endsWith("/things/4932")) return jsonResponse(thing);
    if (call.url.endsWith("/things/4932/files")) return jsonResponse(files);
    if (call.url.endsWith("/things/4932/images")) return jsonResponse(images);
    return new Response("nope", { status: 404 });
  }

  test("maps a thing with a token", async () => {
    const { env, calls } = mockEnv(api);
    const preview = await createImporters({ thingiverseToken: "tok-secret" }, env).preview(url);
    expect(preview.source).toEqual({
      site: "thingiverse",
      url,
      title: "Ultrasonic scanning sensor test platform",
      author: "ng433",
      license: "Creative Commons - Attribution",
      description: "Test platform for **ultrasonic** sensors.\n\nDetails here.\n\n## Print settings\n\n-   0.2 mm layers",
      images: ["https://cdn.thingiverse.com/one_display_l.jpg", "https://cdn.thingiverse.com/two.jpg", "https://cdn.thingiverse.com/default.jpg"],
    });
    expect(preview.files).toEqual([
      { id: "111", name: "base.stl", size: 2048, downloadable: true },
      { id: "112", name: "lid_top.stl", size: 1024, downloadable: true },
    ]);
    expect(preview.blocker).toBeNull();
    expect(calls.every((c) => c.headers.authorization === "Bearer tok-secret")).toBe(true);
  });

  test("without a token: page metadata and the blocker", async () => {
    const { env, calls } = mockEnv(() =>
      htmlResponse('<html><head><title>Ultrasonic by ng433 - Thingiverse</title><meta property="og:title" content="Ultrasonic by ng433"><meta property="og:image" content="https://cdn.thingiverse.com/x.jpg"></head></html>'),
    );
    const preview = await createImporters({}, env).preview(url);
    expect(preview.blocker).toBe("Thingiverse needs an API token (THINGIVERSE_TOKEN)");
    expect(preview.source.site).toBe("thingiverse");
    expect(preview.source.title).toBe("Ultrasonic by ng433");
    expect(preview.source.images).toEqual(["https://cdn.thingiverse.com/x.jpg"]);
    expect(preview.files).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(url);
  });

  test("without a token and behind a bot challenge: bare title, still no throw", async () => {
    const { env } = mockEnv(() => htmlResponse(BOT_PAGE, 403));
    const preview = await createImporters({}, env).preview(url);
    expect(preview.blocker).toBe("Thingiverse needs an API token (THINGIVERSE_TOKEN)");
    expect(preview.source.site).toBe("thingiverse");
    expect(preview.source.title).toBe("thing:4932");
    expect(preview.files).toEqual([]);
  });

  test("a rejected token and a missing thing are ImportErrors that do not leak the token", async () => {
    const importers = createImporters({ thingiverseToken: "tok-secret" }, mockEnv(() => new Response("", { status: 401 })).env);
    const err = await importers.preview(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toBe("Thingiverse rejected the API token");
    await expect(
      createImporters({ thingiverseToken: "tok-secret" }, mockEnv(() => new Response("", { status: 404 })).env).preview(url),
    ).rejects.toThrow("Thingiverse has no such thing");
  });

  test("download follows the CDN redirect without sending the token there", async () => {
    const { env, calls } = mockEnv((call) => {
      if (call.url === "https://api.thingiverse.com/files/111/download") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.thingiverse.com/assets/ab/base.stl?sig=1" } });
      }
      return bytesResponse("solid x\nendsolid x\n");
    });
    const dest = join(dir, "base.stl");
    await createImporters({ thingiverseToken: "tok-secret" }, env).download(url, { id: "111", name: "base.stl", size: null, downloadable: true }, dest);
    expect(await readFile(dest, "utf8")).toContain("solid x");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-secret");
    expect(calls[1]?.url).toBe("https://cdn.thingiverse.com/assets/ab/base.stl?sig=1");
    expect(calls[1]?.headers.authorization).toBeUndefined();
  });

  test("download without a token says what is missing", async () => {
    const { env } = mockEnv(() => jsonResponse({}));
    await expect(
      createImporters({}, env).download(url, { id: "111", name: "base.stl", size: null, downloadable: true }, join(dir, "x")),
    ).rejects.toThrow("THINGIVERSE_TOKEN");
  });
});

describe("makerworld", () => {
  const url = "https://makerworld.com/en/models/1400373-seed-starter";
  // Trimmed from the live response of /v1/design-service/design/{id}.
  const design = {
    id: 1400373,
    title: "Seed Starter ",
    slug: "seed-starter",
    summary: "<p>Self watering <strong>tray</strong></p>",
    coverUrl: "https://makerworld.bblmw.com/makerworld/model/US1/design/cover.jpg",
    license: "Standard Digital File License",
    modelId: "US2bb73b106683e5",
    tags: ["seedtray", "kumiko meyui"],
    tagsTranslated: ["seedtray", "Kumiko Meyui"],
    designCreator: { uid: 1, name: "Meyui", handle: "Meyui" },
    designExtension: {
      design_pictures: [
        { name: "a.jpg", url: "https://makerworld.bblmw.com/makerworld/model/US1/design/a.jpg" },
        { name: "cover", url: "https://makerworld.bblmw.com/makerworld/model/US1/design/cover.jpg" },
      ],
      real_pictures: [{ name: "r.jpg", url: "https://makerworld.bblmw.com/makerworld/model/US1/design/r.jpg" }],
    },
    instances: [
      { id: 1452154, profileId: 298919107, title: "Seed Starter Tray / 9 Cells", extention: { modelInfo: { f3mf: { size: 2870647 } } } },
      { id: 1452158, profileId: 298919564, title: "Seed Starter Tray / 9 Cells", extention: { modelInfo: { f3mf: { size: 0 } } } },
      { id: 1, title: "no profile" },
    ],
  };

  test("anonymous: metadata, files listed but not downloadable, blocker set", async () => {
    const { env, calls } = mockEnv(() => jsonResponse(design));
    const preview = await createImporters({}, env).preview(url);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.bambulab.com/v1/design-service/design/1400373");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(preview.source).toEqual({
      site: "makerworld",
      url,
      title: "Seed Starter",
      author: "Meyui",
      license: "Standard Digital File License",
      description: "Self watering **tray**",
      images: [
        "https://makerworld.bblmw.com/makerworld/model/US1/design/cover.jpg",
        "https://makerworld.bblmw.com/makerworld/model/US1/design/a.jpg",
        "https://makerworld.bblmw.com/makerworld/model/US1/design/r.jpg",
      ],
    });
    expect(preview.files).toEqual([
      { id: "298919107:US2bb73b106683e5", name: "Seed Starter Tray _ 9 Cells.3mf", size: 2870647, downloadable: false },
      { id: "298919564:US2bb73b106683e5", name: "Seed Starter Tray _ 9 Cells-298919564.3mf", size: 0, downloadable: false },
    ]);
    expect(preview.blocker).toBe("MakerWorld needs a Bambu account token to download files (MAKERWORLD_TOKEN)");
  });

  test("with a token: files are downloadable and there is no blocker", async () => {
    const { env } = mockEnv(() => jsonResponse(design));
    const preview = await createImporters({ makerworldToken: "AAB_secret" }, env).preview(url);
    expect(preview.blocker).toBeNull();
    expect(preview.files.every((f) => f.downloadable)).toBe(true);
  });

  test("a missing model is an ImportError", async () => {
    const { env } = mockEnv(() => jsonResponse({ code: 404, error: "The server cannot find the requested resource." }, 404));
    await expect(createImporters({}, env).preview(url)).rejects.toThrow("MakerWorld has no such model");
  });

  test("download: bearer to the API, signed URL to the CDN without it, byte for byte", async () => {
    const signed = "https://makerworld.bblmw.com/makerworld/model/US1/p/f.3mf?at=1&exp=2&key=abc%2Bdef&uid=9&version=v1";
    const { env, calls } = mockEnv((call) => {
      if (call.url.startsWith("https://api.bambulab.com/v1/iot-service/")) return jsonResponse({ url: signed });
      return bytesResponse("PK-3mf-bytes");
    });
    const dest = join(dir, "m", "f.3mf");
    await createImporters({ makerworldToken: "AAB_secret" }, env).download(
      url,
      { id: "298919107:US2bb73b106683e5", name: "f.3mf", size: null, downloadable: true },
      dest,
    );
    expect(await readFile(dest, "utf8")).toBe("PK-3mf-bytes");
    expect(calls[0]?.url).toBe("https://api.bambulab.com/v1/iot-service/api/user/profile/298919107?model_id=US2bb73b106683e5");
    expect(calls[0]?.headers.authorization).toBe("Bearer AAB_secret");
    expect(calls[1]?.url).toBe(signed);
    expect(calls[1]?.headers.authorization).toBeUndefined();
  });

  test("download refuses a signed URL on an unexpected host", async () => {
    const { env, calls } = mockEnv(() => jsonResponse({ url: "https://evil.example/f.3mf" }));
    await expect(
      createImporters({ makerworldToken: "AAB_secret" }, env).download(url, { id: "1:US1", name: "f.3mf", size: null, downloadable: true }, join(dir, "f")),
    ).rejects.toThrow("unexpected host");
    expect(calls).toHaveLength(1);
  });

  test("download: expired token and missing token", async () => {
    const file = { id: "1:US1", name: "f.3mf", size: null, downloadable: true };
    const refused = createImporters({ makerworldToken: "AAB_secret" }, mockEnv(() => new Response("", { status: 401 })).env);
    const err = await refused.download(url, file, join(dir, "f")).catch((e: unknown) => e);
    expect((err as Error).message).toContain("refused the token");
    expect((err as Error).message).not.toContain("AAB_secret");
    await expect(createImporters({}, mockEnv(() => jsonResponse({})).env).download(url, file, join(dir, "f"))).rejects.toThrow("MAKERWORLD_TOKEN");
  });
});

describe("cults3d", () => {
  const url = "https://cults3d.com/en/3d-model/home/print-in-place-cute-lucky-bunny";
  const creation = {
    name: "Print in place cute lucky bunny ",
    description: "<p>A <em>lucky</em> bunny.</p>",
    illustrationImageUrl: "https://images.cults3d.com/cover.jpg",
    illustrations: [{ imageUrl: "https://images.cults3d.com/cover.jpg" }, { imageUrl: "https://images.cults3d.com/two.jpg" }],
    license: { name: "Cults - Private Use" },
    tags: ["bunny", "luck"],
    creator: { nick: "bunnymaker" },
  };

  test("maps a creation; no files, with a by-hand blocker", async () => {
    const { env, calls } = mockEnv(() => jsonResponse({ data: { creation } }));
    const preview = await createImporters({ cults3dUser: "me", cults3dKey: "key-secret" }, env).preview(url);
    expect(preview).toEqual({
      source: {
        site: "cults3d",
        url,
        title: "Print in place cute lucky bunny",
        author: "bunnymaker",
        license: "Cults - Private Use",
        description: "A *lucky* bunny.",
        images: ["https://images.cults3d.com/cover.jpg", "https://images.cults3d.com/two.jpg"],
      },
      files: [],
      blocker: "Cults3D does not hand out files; download them from the site by hand and upload them here",
    });
    expect(calls[0]?.url).toBe("https://cults3d.com/graphql");
    expect(calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from("me:key-secret").toString("base64")}`);
    expect(JSON.parse(calls[0]!.body!).variables).toEqual({ slug: "print-in-place-cute-lucky-bunny" });
  });

  test("without credentials: page metadata and the blocker", async () => {
    const { env } = mockEnv(() => htmlResponse('<title>Bunny - Cults</title><meta property="og:description" content="A bunny">'));
    const preview = await createImporters({ cults3dUser: "me" }, env).preview(url);
    expect(preview.blocker).toBe("Cults3D needs API credentials (CULTS3D_USER, CULTS3D_KEY)");
    expect(preview.source.title).toBe("Bunny - Cults");
    expect(preview.source.description).toBe("A bunny");
    expect(preview.source.site).toBe("cults3d");
  });

  test("without credentials and behind a bot challenge: title from the slug", async () => {
    const { env } = mockEnv(() => htmlResponse(BOT_PAGE, 403));
    const preview = await createImporters({}, env).preview(url);
    expect(preview.source.title).toBe("print in place cute lucky bunny");
    expect(preview.blocker).toContain("CULTS3D_USER");
  });

  test("a null creation, GraphQL errors and bad credentials", async () => {
    const creds = { cults3dUser: "me", cults3dKey: "key-secret" };
    await expect(createImporters(creds, mockEnv(() => jsonResponse({ data: { creation: null } })).env).preview(url)).rejects.toThrow("no such model");
    await expect(createImporters(creds, mockEnv(() => jsonResponse({ errors: [{ message: "bad field" }] })).env).preview(url)).rejects.toThrow("Cults3D API error: bad field");
    const err = await createImporters(creds, mockEnv(() => new Response("HTTP Basic: Access denied.", { status: 401 })).env).preview(url).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Cults3D rejected the API credentials");
  });

  test("download is always refused", async () => {
    const { env } = mockEnv(() => jsonResponse({}));
    await expect(createImporters({}, env).download(url, { id: "1", name: "a.stl", size: null, downloadable: false }, join(dir, "a"))).rejects.toThrow("by hand");
  });
});

describe("myminifactory", () => {
  const url = "https://www.myminifactory.com/object/3d-print-dragon-98765";
  const object = {
    id: 98765,
    name: "Dragon ",
    description: "Plain text.",
    description_html: "<p>A <strong>big</strong> dragon.</p>",
    printing_details_html: "<p>Supports needed.</p>",
    designer: { username: "dragonsmith", name: "Dragon Smith" },
    images: [
      { id: 2, is_primary: false, original: { url: "https://cdn.myminifactory.com/two.jpg" } },
      { id: 1, is_primary: true, original: { url: "https://cdn.myminifactory.com/one.jpg" } },
      { id: 3, standard: { url: "https://cdn.myminifactory.com/three_std.jpg" } },
    ],
    files: { total_count: 2, items: [{ id: 5, filename: "head.stl", size: "2048" }, { id: 6, filename: "body.stl", size: 4096 }] },
    tags: ["dragon", "fantasy"],
    license: "Attribution",
  };

  test("maps an object; files are listed but never downloadable", async () => {
    const { env, calls } = mockEnv(() => jsonResponse(object));
    const preview = await createImporters({ myminifactoryKey: "key-secret" }, env).preview(url);
    expect(preview).toEqual({
      source: {
        site: "myminifactory",
        url,
        title: "Dragon",
        author: "Dragon Smith",
        license: "Attribution",
        description: "A **big** dragon.\n\n## Printing details\n\nSupports needed.",
        images: ["https://cdn.myminifactory.com/one.jpg", "https://cdn.myminifactory.com/two.jpg", "https://cdn.myminifactory.com/three_std.jpg"],
      },
      files: [
        { id: "5", name: "head.stl", size: 2048, downloadable: false },
        { id: "6", name: "body.stl", size: 4096, downloadable: false },
      ],
      blocker: "MyMiniFactory only hands out files to logged-in users; download them from the site by hand and upload them here",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://www.myminifactory.com/api/v2/objects/98765?key=key-secret");
  });

  test("fetches the file list when the object does not embed it", async () => {
    const { files: _omit, ...bare } = object;
    const { env, calls } = mockEnv((call) =>
      call.url.includes("/files") ? jsonResponse({ total_count: 1, items: [{ id: 5, filename: "head.stl", size: "2048" }] }) : jsonResponse(bare),
    );
    const preview = await createImporters({ myminifactoryKey: "key-secret" }, env).preview(url);
    expect(calls).toHaveLength(2);
    expect(preview.files).toEqual([{ id: "5", name: "head.stl", size: 2048, downloadable: false }]);
  });

  test("without a key: page metadata and the blocker", async () => {
    const { env, calls } = mockEnv(() => htmlResponse('<title>Dragon - MMF</title>'));
    const preview = await createImporters({}, env).preview(url);
    expect(preview.blocker).toBe("MyMiniFactory needs an API key (MYMINIFACTORY_KEY)");
    expect(preview.source.title).toBe("Dragon - MMF");
    expect(calls[0]?.url).toBe(url);
  });

  test("errors never contain the key", async () => {
    for (const status of [401, 404, 500]) {
      const { env } = mockEnv(() => new Response("", { status }));
      const err = await createImporters({ myminifactoryKey: "key-secret" }, env).preview(url).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as Error).message).not.toContain("key-secret");
    }
  });
});

describe("generic", () => {
  test("title, og tags, author, license, relative image", async () => {
    const html = `<!doctype html><html><head>
      <title>Fallback &amp; title</title>
      <meta property="og:title" content="Gearbox &amp; case">
      <meta property="og:description" content="A <b>small</b> gearbox">
      <meta property="og:image" content="/img/cover.png">
      <meta name="author" content="Jane Doe">
      <link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
      <script>document.title = "x"</script>
    </head><body>hi</body></html>`;
    const { env } = mockEnv(() => htmlResponse(html));
    const preview = await createImporters({}, env).preview("https://example.org/models/gearbox");
    expect(preview).toEqual({
      source: {
        site: "generic",
        url: "https://example.org/models/gearbox",
        title: "Gearbox & case",
        author: "Jane Doe",
        license: "https://creativecommons.org/licenses/by/4.0/",
        description: "A **small** gearbox",
        images: ["https://example.org/img/cover.png"],
      },
      files: [],
      blocker: null,
    });
  });

  test("a bare page without any meta does not throw", async () => {
    const { env } = mockEnv(() => htmlResponse("<html><body>nothing</body></html>"));
    const preview = await createImporters({}, env).preview("https://example.org/a/some-thing-here");
    expect(preview.source.title).toBe("some thing here");
    expect(preview.source.author).toBeNull();
  });

  test("a non-HTML 200 does not throw either", async () => {
    const { env } = mockEnv(() => bytesResponse("%PDF", "application/pdf"));
    const preview = await createImporters({}, env).preview("https://example.org/doc/manual.pdf");
    expect(preview.source.title).toBe("manual.pdf");
  });

  test("bot challenges throw an ImportError with a plain message", async () => {
    for (const status of [403, 503]) {
      const { env } = mockEnv(() => htmlResponse(BOT_PAGE, status));
      const err = await createImporters({}, env).preview("https://example.org/x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as Error).message).toContain("bot challenge");
      expect((err as Error).message).toContain(`HTTP ${status}`);
    }
  });

  test("404 and unreachable hosts throw", async () => {
    await expect(createImporters({}, mockEnv(() => htmlResponse("", 404)).env).preview("https://example.org/x")).rejects.toThrow("no such page");
    const down = { fetch: async () => Promise.reject(new TypeError("fetch failed")), sleep: async () => {} };
    await expect(createImporters({}, down).preview("https://example.org/x")).rejects.toThrow("unreachable");
  });

  test("a non-http address is refused before any request", async () => {
    const { env, calls } = mockEnv(() => htmlResponse(""));
    const importers = createImporters({}, env);
    await expect(importers.preview("file:///etc/passwd")).rejects.toThrow("http and https");
    await expect(importers.preview("nonsense")).rejects.toThrow("valid web address");
    expect(calls).toHaveLength(0);
  });

  test("download on a generic site says there is nothing to download", async () => {
    const { env } = mockEnv(() => htmlResponse(""));
    await expect(createImporters({}, env).download("https://example.org/x", { id: "1", name: "a", size: null, downloadable: true }, join(dir, "a"))).rejects.toThrow("no files");
  });
});
