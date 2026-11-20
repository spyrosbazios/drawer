import type { DrawerEvent } from "@drawer/shared/api";

type Listener = (event: DrawerEvent) => void;
type ReconnectListener = () => void;

const EVENT_TYPES: readonly DrawerEvent["type"][] = ["project", "file", "render", "render_progress", "part", "assembly", "session", "settings"];

const MIN_DELAY = 1_000;
const MAX_DELAY = 60_000;

function isEvent(v: unknown): v is DrawerEvent {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === "string" && EVENT_TYPES.some((x) => x === t);
}

/**
 * One SSE stream for the whole app. Reconnects with exponential backoff (1 s to 60 s), at once when the
 * browser comes back online, and stays closed while offline. `onReconnect` fires after every reconnect:
 * events were probably missed, so subscribers should refresh everything they show.
 */
export function openRealtime(onEvent: Listener, onReconnect: ReconnectListener): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = MIN_DELAY;
  let everOpened = false;
  let closed = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const connect = () => {
    clear();
    if (closed || !navigator.onLine) return;
    source?.close();
    const es = new EventSource("/api/events");
    source = es;
    es.onopen = () => {
      delay = MIN_DELAY;
      if (everOpened) onReconnect();
      everOpened = true;
    };
    const handle = (m: MessageEvent<string>) => {
      try {
        const data: unknown = JSON.parse(m.data);
        if (isEvent(data)) onEvent(data);
      } catch {
        // A malformed frame is ignored; the next one is independent.
      }
    };
    // The contract says `data` is a DrawerEvent; whether the server also names the SSE event is its choice.
    es.onmessage = handle;
    for (const name of EVENT_TYPES) es.addEventListener(name, (e) => handle(e as MessageEvent<string>));
    es.onerror = () => {
      es.close();
      if (source === es) source = null;
      if (closed) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  };

  const onOnline = () => {
    delay = MIN_DELAY;
    connect();
  };
  const onOffline = () => {
    clear();
    source?.close();
    source = null;
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  connect();

  return () => {
    closed = true;
    clear();
    source?.close();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
