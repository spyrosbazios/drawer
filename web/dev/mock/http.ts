import type { ApiError, DrawerEvent, ErrorCode } from "../../../shared/src/api";

const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly rev?: string,
  ) {
    super(message);
  }
}

export const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  exists: 409,
  invalid: 400,
  edit_no_match: 422,
  render_failed: 422,
  import_failed: 502,
  forbidden: 403,
  internal: 500,
};

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export function fail(code: ErrorCode, message: string, status: number, rev?: string): Response {
  const body: ApiError = { error: code, message, ...(rev ? { rev } : {}) };
  return json(body, status);
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError("invalid", "The body is not JSON");
  }
}

// ---- events ------------------------------------------------------------------------------

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

export function broadcast(e: DrawerEvent): void {
  const frame = encoder.encode(`data: ${JSON.stringify(e)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(frame);
    } catch {
      clients.delete(c);
    }
  }
}

export function eventStream(): Response {
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      clients.add(c);
      c.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      if (ctl) clients.delete(ctl);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

/** A heartbeat keeps proxies from closing an idle event stream. */
export function startHeartbeat(): void {
  setInterval(() => {
    const ping = encoder.encode(": ping\n\n");
    for (const c of clients) {
      try {
        c.enqueue(ping);
      } catch {
        clients.delete(c);
      }
    }
  }, 15_000);
}
