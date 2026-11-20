/**
 * Who may talk to the server at all. drawer has no authentication: it trusts the network it listens on.
 * That trust must not extend to web pages the owner happens to open, which can make their browser send
 * requests here. Two checks close that gap:
 *
 * - DNS rebinding (every request, API and web app): a page on `evil.example` can re-point that name at
 *   this server and then read it "same-origin". The request still says `Host: evil.example`, so only Host
 *   names the operator listed are served. IP literals and `localhost` are always fine: a rebinding attack
 *   needs a name the attacker controls, and nobody controls those.
 * - Cross-site writes (every /api request that is not GET or HEAD): a page elsewhere can POST here with a
 *   form or a CORS "simple" fetch. Browsers mark such a request with `Origin` and `Sec-Fetch-Site`, which
 *   page script cannot forge. The server sends no CORS headers, so a cross-site page cannot add headers or
 *   read answers either. A request with neither header comes from a non-browser client (the CLI, the
 *   runner), which no web page can drive.
 *
 * Reverse proxies: `Origin` is compared with the `Host` the request arrived with, never with
 * `X-Forwarded-Host`. A cross-site page cannot set that header (it is not CORS-safelisted, and without CORS
 * headers its preflight fails), but a rebinding page talks to us "same-origin" and can set any header, so
 * trusting it would let the attacker pick the value Origin is compared with. A proxy in front of drawer
 * must pass the client's Host through (Caddy does by default; nginx needs `proxy_set_header Host $host`)
 * and its name goes in DRAWER_ALLOWED_HOSTS. Only host and port are compared, not the scheme: TLS usually
 * ends at the proxy, so an `https://` Origin legitimately meets a plain-http request.
 *
 * GET requests carry neither header reliably (an `<img>` or a navigation), which is why no GET route may
 * change anything.
 */
import { isIP } from "node:net";
import { forbidden } from "../errors.ts";

/** `host[:port]` normalised by the URL parser (lower case, default port dropped), or null when malformed. */
function parseHost(raw: string): { host: string; hostname: string } | null {
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return { host: url.host, hostname: url.hostname };
}

/** The Host the request arrived with. In-process requests (tests) have no header; their URL carries it. */
function requestHost(req: Request): string | null {
  const header = req.headers.get("host");
  if (header !== null) return header;
  try {
    return new URL(req.url).host;
  } catch {
    return null;
  }
}

/** A hostname as compared with DRAWER_ALLOWED_HOSTS: lower case, without a trailing dot. */
export function normalizeHostname(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}

/** Throws 403 unless the request may be served. `allowedHosts` are normalised (see normalizeHostname). */
export function guardRequest(req: Request, allowedHosts: readonly string[]): void {
  const raw = requestHost(req);
  const host = raw === null ? null : parseHost(raw);
  if (host === null) throw forbidden("the request has no valid Host header");
  const name = normalizeHostname(host.hostname);
  if (!isIpLiteral(host.hostname) && name !== "localhost" && !allowedHosts.includes(name)) {
    throw forbidden(
      `drawer does not answer to the host name "${name}". If that is how you reach this server, add it to DRAWER_ALLOWED_HOSTS ` +
        `(comma-separated host names, e.g. DRAWER_ALLOWED_HOSTS=${name}) and restart the server. IP addresses and localhost always work.`,
    );
  }

  if (req.method === "GET" || req.method === "HEAD") return;
  // A valid Host makes the URL absolute.
  const { pathname } = new URL(req.url);
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return;
  if (req.headers.get("sec-fetch-site") === "cross-site") throw forbidden("cross-site requests are refused");
  const origin = req.headers.get("origin");
  if (origin === null) return;
  let originHost: string | null;
  try {
    const url = new URL(origin);
    originHost = url.protocol === "http:" || url.protocol === "https:" ? new URL(`http://${url.host}`).host : null;
  } catch {
    originHost = null;
  }
  if (originHost === null || normalizeHostname(originHost) !== normalizeHostname(host.host)) {
    throw forbidden(`cross-origin requests are refused (Origin ${origin} is not ${host.host})`);
  }
}
