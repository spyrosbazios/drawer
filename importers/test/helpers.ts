import type { HttpEnv } from "../src/index";

/** A resolver that answers every name with one public address, so no test needs the network. */
export const PUBLIC_ADDRESS = "93.184.215.14";
export const publicResolve = async (): Promise<string[]> => [PUBLIC_ADDRESS];

export interface Call {
  url: string;
  /** The address the request was pinned to. */
  address: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** A stand-in `fetch` that records every call and answers through `handler`. No waiting between retries. */
export function mockEnv(handler: Handler): { env: HttpEnv; calls: Call[] } {
  const calls: Call[] = [];
  const env: HttpEnv = {
    fetch: async (url, init, address) => {
      const call: Call = {
        url,
        address,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return handler(call);
    },
    resolve: publicResolve,
    sleep: async () => {},
  };
  return { env, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function bytesResponse(bytes: Uint8Array | string, type = "application/octet-stream"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": type } });
}
