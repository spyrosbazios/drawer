/**
 * The main-thread side of measure-worker.ts: one lazily started worker, held (ref'd) only
 * while a request is outstanding so a process holding a renderer can still exit.
 *
 * A worker that dies for any reason (an exception, running out of memory, being terminated) fails
 * every request it held, and the next request starts a fresh one. A request that gets no answer within
 * the timeout fails too, and its worker is replaced: it may be stuck, and the worker is single-threaded.
 */
import type { Ask, WorkerAnswer, WorkerReply, WorkerRequest } from "./measure-protocol";

type Answer<O extends Ask["op"]> = Extract<WorkerAnswer, { op: O }>;

/** Generous: a 200k-triangle analysis takes seconds. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface MeasureClientOptions {
  /** The worker module; tests substitute one that misbehaves. */
  workerUrl?: string;
  timeoutMs?: number;
}

interface Pending {
  resolve: (a: WorkerAnswer) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MeasureClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly workerUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: MeasureClientOptions = {}) {
    this.workerUrl = opts.workerUrl ?? new URL("./measure-worker.ts", import.meta.url).href;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  ask<A extends Ask>(ask: A): Promise<Answer<A["op"]>> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise<WorkerAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.stop(worker, new Error(`the measuring worker did not answer within ${Math.round(this.timeoutMs / 1000)} s (${ask.op})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (this.pending.size === 1) worker.ref();
      const req: WorkerRequest = { ...ask, id };
      worker.postMessage(req);
    }) as Promise<Answer<A["op"]>>;
  }

  terminate(): void {
    if (this.worker) this.stop(this.worker, new Error("the measuring worker was stopped"));
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    worker.unref();
    worker.addEventListener("message", (ev: MessageEvent<WorkerReply>) => {
      if (worker !== this.worker) return;
      const reply = ev.data;
      const p = this.pending.get(reply.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(reply.id);
      if (this.pending.size === 0) worker.unref();
      if (reply.ok) p.resolve(reply);
      else p.reject(new Error(reply.error));
    });
    worker.addEventListener("error", (ev: ErrorEvent) => {
      this.stop(worker, new Error(`the measuring worker crashed: ${ev.message}`));
    });
    worker.addEventListener("close", () => {
      this.stop(worker, new Error("the measuring worker exited"));
    });
    this.worker = worker;
    return worker;
  }

  /** Ends `worker` and fails what it held; a no-op for a worker already replaced. */
  private stop(worker: Worker, e: Error): void {
    if (worker !== this.worker) return;
    this.worker = null;
    worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
