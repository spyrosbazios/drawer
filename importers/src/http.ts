/**
 * The one HTTP layer every site module goes through: a generic client User-Agent, a 30 s timeout,
 * at most two retries with backoff on 429/5xx, manual redirects (credentials never follow a
 * cross-origin hop), and size-capped streaming downloads.
 *
 * Every hop (the first URL and each redirect) goes only to a public address (address.ts): a name is
 * resolved, all of its addresses must be public, and the connection is then made to the address that was
 * checked, so a name that re-resolves between the check and the connect (DNS rebinding) cannot point the
 * request at the owner's network. See pinnedFetch for how the connection is pinned.
 *
 * Errors never carry the request URL: some sites take their key in the query string and signed
 * download URLs are credentials themselves. Callers pass a plain `label` for messages instead.
 */
import { lookup } from "node:dns/promises";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { checkServerIdentity } from "node:tls";
import { ImportError } from "@drawer/shared/contracts";
import { hostTarget, isPublicAddress } from "./address";

export const USER_AGENT = "drawer-importer/0.1";
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 2;
export const MAX_REDIRECTS = 5;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** One request, connected to `address` (an IP that passed the address policy) whatever `url`'s host resolves to now. */
export type PinnedFetchFn = (url: string, init: RequestInit, address: string) => Promise<Response>;

/** What tests (and nothing else) replace. */
export interface HttpEnv {
  fetch?: PinnedFetchFn;
  /** Every address a host name resolves to. Default: the system resolver (getaddrinfo), all records. */
  resolve?: (name: string) => Promise<string[]>;
  /** The address policy. Default: isPublicAddress. Tests that talk to a local server widen it. */
  isPublic?: (address: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** First retry delay; doubles per attempt. Default 800 ms. */
  backoffMs?: number;
}

export interface RequestOptions {
  /** Plain words naming the remote, used in error messages instead of the URL. */
  label: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Headers that must not follow a redirect to another origin (default: authorization). */
  originBound?: string[];
  /**
   * Refuse any redirect to another origin. For requests whose URL itself carries a credential (an API
   * key in the query string): a redirect elsewhere is never followed, whatever it would carry along.
   */
  sameOrigin?: boolean;
}

export interface Http {
  request(url: string, opts: RequestOptions): Promise<Response>;
  /** GET/POST and parse JSON. Throws ImportError on HTTP errors, unreachable hosts and non-JSON bodies. */
  json<T>(url: string, opts: RequestOptions): Promise<T>;
  /** Stream a response body to `destPath`, enforcing `maxBytes`. */
  download(url: string, opts: RequestOptions & { maxBytes: number; kind: "file" | "image" }, destPath: string): Promise<void>;
}

/** An ImportError that trying again cannot fix: a refused address or redirect. */
class RefusedError extends ImportError {}

const RETRY_STATUS = (s: number) => s === 429 || s >= 500;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if ("name" in err && (err.name === "TimeoutError" || err.name === "AbortError")) return "timed out";
    if ("code" in err && typeof err.code === "string") return err.code;
  }
  return "network error";
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, 10_000);
}

/**
 * The request `pinnedFetch` makes: the URL with its host replaced by the checked address, the original
 * Host header, and for https the original name as TLS SNI and as the name the certificate must match.
 * Bun's fetch would otherwise check the certificate against the IP in the URL; `checkServerIdentity`
 * replaces only that name check, the chain is still verified against the system CAs. (Bun's node:https
 * `lookup` option was tried first: Bun 1.3.9 then verifies the certificate against the IP and every
 * legitimate https request fails.)
 */
export function pinnedRequest(url: string, init: RequestInit, address: string): { url: string; init: RequestInit } {
  const target = new URL(url);
  const original = target.hostname;
  const literal = hostTarget(target).kind === "ip";
  if (literal) return { url, init: { ...init, keepalive: false } };
  const headers = new Headers(init.headers);
  headers.set("host", target.host);
  target.hostname = address.includes(":") ? `[${address}]` : address;
  const tls = target.protocol === "https:" ? { tls: { serverName: original, checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(original, cert) } } : {};
  // No connection reuse: a pooled connection to the same address must not stand in for this name's handshake.
  return { url: target.toString(), init: { ...init, headers, keepalive: false, ...tls } };
}

/** The production fetch: connects to `address` only (see pinnedRequest). */
export const pinnedFetch: PinnedFetchFn = (url, init, address) => {
  const pinned = pinnedRequest(url, init, address);
  return fetch(pinned.url, pinned.init);
};

async function systemResolve(name: string): Promise<string[]> {
  return (await lookup(name, { all: true, verbatim: true })).map((a) => a.address);
}

export function createHttp(env: HttpEnv = {}): Http {
  const doFetch = env.fetch ?? pinnedFetch;
  const resolve = env.resolve ?? systemResolve;
  const isPublic = env.isPublic ?? isPublicAddress;
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = env.backoffMs ?? 800;

  /**
   * The address to connect to for `url`: an IP literal as it is, a name's first address once every
   * address it resolves to is public. The message never names the URL (see the file comment).
   */
  async function vet(url: URL, label: string): Promise<string> {
    const target = hostTarget(url);
    if (target.kind === "local") throw new RefusedError(`${label} refused: the address is not public`);
    let addresses: string[];
    if (target.kind === "ip") addresses = [target.address];
    else {
      try {
        addresses = await resolve(target.name);
      } catch (err) {
        throw new ImportError(`${label} is unreachable (${errorCode(err)})`);
      }
    }
    const first = addresses[0];
    if (first === undefined) throw new ImportError(`${label} is unreachable (no address)`);
    if (!addresses.every(isPublic)) throw new RefusedError(`${label} refused: the address is not public`);
    return first;
  }

  /** One hop at a time so redirects can drop credentials. `deadline` bounds the wait for headers. */
  async function send(url: string, opts: RequestOptions, signal: AbortSignal): Promise<Response> {
    let current = url;
    let headers: Record<string, string> = { "user-agent": USER_AGENT, ...lowerKeys(opts.headers) };
    let method = opts.method ?? "GET";
    let body = opts.body;
    const bound = (opts.originBound ?? ["authorization"]).map((h) => h.toLowerCase());

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        throw new ImportError(`${opts.label} has an invalid address`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ImportError(`${opts.label} has an unsupported address`);
      const address = await vet(parsed, opts.label);
      let res: Response;
      try {
        res = await doFetch(current, { method, headers, body, redirect: "manual", signal }, address);
      } catch (err) {
        throw new ImportError(`${opts.label} is unreachable (${errorCode(err)})`);
      }
      const location = res.headers.get("location");
      if (!REDIRECT_STATUS.has(res.status) || !location) return res;
      await res.body?.cancel();
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new ImportError(`${opts.label} sent an invalid redirect`);
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        throw new ImportError(`${opts.label} redirected to an unsupported address`);
      }
      if (next.origin !== parsed.origin) {
        if (opts.sameOrigin) throw new RefusedError(`${opts.label} redirected to another site, which is not followed for this request`);
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !bound.includes(k)));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "content-type"));
      }
      current = next.toString();
    }
    throw new ImportError(`${opts.label} redirected too many times`);
  }

  /**
   * `signalFor` gives each attempt its abort signal; the default is a 30 s limit on the whole
   * exchange. Streaming downloads pass their own so a slow but steady transfer is not cut off.
   */
  async function request(
    url: string,
    opts: RequestOptions,
    signalFor: () => AbortSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const signal = signalFor();
      let res: Response | null = null;
      let failure: ImportError | null = null;
      try {
        res = await send(url, opts, signal);
      } catch (err) {
        if (!(err instanceof ImportError) || err instanceof RefusedError) throw err;
        failure = err;
      }
      if (res && !RETRY_STATUS(res.status)) return res;
      if (attempt >= MAX_RETRIES) {
        if (res) return res;
        throw failure ?? new ImportError(`${opts.label} is unreachable`);
      }
      const wait = (res ? retryAfterMs(res) : null) ?? backoff * 2 ** attempt;
      await res?.body?.cancel();
      await sleep(wait);
    }
  }

  async function json<T>(url: string, opts: RequestOptions): Promise<T> {
    const res = await request(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
    if (!res.ok) throw new ImportError(`${opts.label} answered HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ImportError(`${opts.label} did not answer with JSON`);
    }
  }

  async function download(
    url: string,
    opts: RequestOptions & { maxBytes: number; kind: "file" | "image" },
    destPath: string,
  ): Promise<void> {
    // 30 s to get headers, then 30 s of silence at most between chunks.
    const controller = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    };
    let res: Response;
    try {
      res = await request(url, opts, () => {
        arm();
        return controller.signal;
      });
    } catch (err) {
      clearTimeout(idle);
      throw err;
    }
    if (!res.ok) {
      clearTimeout(idle);
      await res.body?.cancel();
      throw new ImportError(`${opts.label} answered HTTP ${res.status}`);
    }
    const capMb = Math.round(opts.maxBytes / (1024 * 1024));
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      clearTimeout(idle);
      await res.body?.cancel();
      throw new ImportError(`${opts.kind === "file" ? "File" : "Image"} is larger than the ${capMb} MB limit`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (type === "text/html" || type === "application/json") {
      clearTimeout(idle);
      await res.body?.cancel();
      throw new ImportError(`${opts.label} returned a web page instead of the ${opts.kind}`);
    }
    if (!res.body) {
      clearTimeout(idle);
      throw new ImportError(`${opts.label} returned an empty response`);
    }

    await mkdir(dirname(destPath), { recursive: true });
    const handle = await open(destPath, "w");
    let total = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new ImportError(`${opts.kind === "file" ? "File" : "Image"} is larger than the ${capMb} MB limit`);
        }
        await handle.write(value);
      }
    } catch (err) {
      clearTimeout(idle);
      await handle.close();
      await rm(destPath, { force: true });
      if (err instanceof ImportError) throw err;
      throw new ImportError(`${opts.label} download was interrupted (${errorCode(err)})`);
    }
    clearTimeout(idle);
    await handle.close();
  }

  return { request, json, download };
}

function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}
