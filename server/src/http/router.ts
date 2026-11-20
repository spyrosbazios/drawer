import { ApiException, invalid } from "../errors.ts";

export interface RouteContext {
  req: Request;
  url: URL;
  /** `:name` segments, decoded. */
  params: Record<string, string>;
  /** The decoded remainder matched by a trailing `*`, joined with "/". */
  rest: string;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  wildcard: boolean;
  handler: Handler;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw invalid("malformed percent-encoding in the URL");
  }
}

/** A tiny pattern router: `/projects/:slug/files/*`. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const parts = pattern.split("/").filter((p) => p !== "");
    const wildcard = parts[parts.length - 1] === "*";
    this.routes.push({ method, segments: wildcard ? parts.slice(0, -1) : parts, wildcard, handler });
  }

  /** `path` is the URL path without the `/api` prefix. Null when no route matches. */
  match(method: string, path: string): { handler: Handler; params: Record<string, string>; rest: string } | null {
    const parts = path.split("/").filter((p) => p !== "");
    let methodMismatch = false;
    for (const route of this.routes) {
      if (parts.length < route.segments.length || (!route.wildcard && parts.length !== route.segments.length)) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (const [i, seg] of route.segments.entries()) {
        const part = parts[i] as string;
        if (seg.startsWith(":")) params[seg.slice(1)] = decode(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params, rest: parts.slice(route.segments.length).map(decode).join("/") };
    }
    if (methodMismatch) throw new ApiException("invalid", `method ${method} not allowed on /api${path}`);
    return null;
  }
}
