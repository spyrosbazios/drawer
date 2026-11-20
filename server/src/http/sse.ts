import type { EventBus } from "../events.ts";

const KEEPALIVE_MS = 15_000;

/** Open event streams, so `close()` can end them. */
export class SseRegistry {
  private readonly closers = new Set<() => void>();

  add(close: () => void): () => void {
    this.closers.add(close);
    return () => {
      this.closers.delete(close);
    };
  }

  closeAll(): void {
    for (const close of [...this.closers]) close();
  }
}

export function sseResponse(bus: EventBus, registry: SseRegistry, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      const send = (text: string): void => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = bus.subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const timer = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      const unregister = registry.add(() => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        unsubscribe();
        unregister();
      };
      signal.addEventListener("abort", () => cleanup(), { once: true });
      send(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
