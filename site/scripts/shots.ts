// The product screenshots in docs/assets/, taken from the web app running against its mock server.
// Starts nothing itself: give it the URL of a running web dev server (site/README.md has the commands).
//
//   bun scripts/shots.ts http://127.0.0.1:5201 [name ...]
//
// It drives headless Chromium over the DevTools protocol with Bun's own WebSocket, so it has no dependency and works
// with whichever Chromium build DRAWER_CHROME points at. GL (SwiftShader) is switched on only for the shots that show
// the 3D viewer: with it, headless Chromium starves under the `heavy` cap (web/AGENTS.md, footguns).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.DRAWER_CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux64/chrome");
const OUT = fileURLToPath(new URL("../../docs/assets/", import.meta.url));
const MAX_BYTES = 450 * 1024;

type Theme = "light" | "dark";
type Shot = {
  name: string;
  path: string;
  /** Visible text that proves the screen has loaded what it should show. */
  ready: string[];
  gl?: boolean;
  phone?: boolean;
  themes: Theme[];
  /** Extra time after the screen is ready, for renders and transitions. */
  settle?: number;
  /** JavaScript run in the page once it is ready, before the capture. */
  prepare?: string;
};

const SHOTS: Shot[] = [
  { name: "home", path: "/", ready: ["Desk organiser", "Spool holder"], gl: false, themes: ["light"], settle: 1200 },
  { name: "part", path: "/p/desk-organiser?part=cable-clip&panel=review", ready: ["Snap arm wall"], gl: true, themes: ["light", "dark"], settle: 3000 },
  { name: "session", path: "/p/desk-organiser?part=cable-clip", ready: ["raise arm_t"], gl: true, themes: ["light", "dark"], settle: 3000 },
  // The review panel scrolled to its end: parameters as sliders, the person's actions (waive, print result), next steps.
  {
    name: "review",
    path: "/p/desk-organiser?part=cable-clip&panel=review",
    ready: ["Snap arm wall"],
    gl: true,
    themes: ["light"],
    settle: 3000,
    prepare: `document.querySelector('[data-scroll-restoration-id^="panel|review"]')?.scrollTo(0, 1e6)`,
  },
  { name: "assembly", path: "/p/desk-organiser?assembly=1&panel=review", ready: ["clash"], gl: true, themes: ["light"], settle: 3000 },
  { name: "phone", path: "/p/desk-organiser?part=cable-clip", ready: ["Snap arm wall", "ATTEMPTS"], gl: true, phone: true, themes: ["light"], settle: 1500 },
];

/** A DevTools connection to the browser; page commands go through a flattened session. */
class Cdp {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message));
      else w?.resolve(msg.result);
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    });
  }
  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve: (v) => resolve(v as T), reject }));
  }
  close() {
    this.ws.close();
  }
}

async function launch(gl: boolean) {
  const profile = mkdtempSync(join(tmpdir(), "drawer-shots-"));
  const flags = gl ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : ["--disable-gpu"];
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--font-render-hinting=none", ...flags, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let err = "";
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m?.[1]) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}): ${err.slice(-500)}`)));
  });
  const cdp = await Cdp.open(url);
  return {
    cdp,
    async close() {
      cdp.close();
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function take(cdp: Cdp, base: string, shot: Shot, theme: Theme) {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const send = <T>(m: string, p: Record<string, unknown> = {}) => cdp.send<T>(m, p, sessionId);
  const evaluate = async <T>(expression: string) =>
    (await send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

  const [width, height, scale] = shot.phone ? [390, 844, 3] : [1440, 900, 2];
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: !!shot.phone });
  if (shot.phone) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // The app follows the system theme when nothing is stored; reduced motion makes every transition end at once.
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.enable");
  await send("Page.navigate", { url: new URL(shot.path, base).href });

  // Ready: the boot splash is gone, the expected text is on screen, and nothing is still loading.
  const check = `(() => {
    if (document.getElementById("boot")) return false;
    const text = document.body.innerText;
    if (!${JSON.stringify(shot.ready)}.every((t) => text.includes(t))) return false;
    const busy = [...document.querySelectorAll('[data-slot="spinner"], .animate-spin, [aria-busy="true"]')]
      .some((el) => el.getClientRects().length > 0);
    return !busy;
  })()`;
  const deadline = Date.now() + 30_000;
  while (!(await evaluate<boolean>(check))) {
    if (Date.now() > deadline) throw new Error(`${shot.name} (${theme}): not ready after 30 s; page text: ${(await evaluate<string>("document.body.innerText")).slice(0, 600)}`);
    await sleep(250);
  }
  if (shot.prepare) await evaluate(shot.prepare);
  await sleep(shot.settle ?? 800);

  // WebP at the device scale; if that is too large, step the quality down, then fall back to the 1x logical size.
  const file = join(OUT, theme === "light" ? `${shot.name}.webp` : `${shot.name}-dark.webp`);
  const attempts: { quality: number; scale: number }[] = [
    { quality: 90, scale: 1 },
    { quality: 82, scale: 1 },
    { quality: 75, scale: 1 },
    { quality: 90, scale: 1 / scale },
    { quality: 80, scale: 1 / scale },
  ];
  for (const a of attempts) {
    const clip = a.scale === 1 ? undefined : { x: 0, y: 0, width, height, scale: a.scale };
    const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "webp", quality: a.quality, ...(clip ? { clip } : {}) });
    const bytes = Buffer.from(data, "base64");
    if (bytes.length <= MAX_BYTES) {
      await Bun.write(file, bytes);
      process.stdout.write(`${file}  ${Math.round(bytes.length / 1024)} KB  q${a.quality}${a.scale === 1 ? "" : " 1x"}\n`);
      await cdp.send("Target.closeTarget", { targetId });
      return;
    }
  }
  throw new Error(`${shot.name} (${theme}): over ${MAX_BYTES} bytes at every setting`);
}

const [base, ...only] = process.argv.slice(2);
if (!base) {
  process.stderr.write("usage: bun scripts/shots.ts <web dev server URL> [shot name ...]\n");
  process.exit(1);
}
statSync(CHROME);
const chosen = SHOTS.filter((s) => only.length === 0 || only.includes(s.name));
for (const gl of [false, true]) {
  const group = chosen.filter((s) => !!s.gl === gl);
  if (group.length === 0) continue;
  const browser = await launch(gl);
  try {
    for (const shot of group) for (const theme of shot.themes) await take(browser.cdp, base, shot, theme);
  } finally {
    await browser.close();
  }
}
