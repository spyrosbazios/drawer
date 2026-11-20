/**
 * One job at a time, high priority before low. A job is found by key, so a second request for the
 * same work joins the first instead of running it again; a running job can take a new key once it
 * knows exactly which state it is working on.
 */
interface Job {
  key: string;
  high: boolean;
  run: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  started: boolean;
}

export class JobQueue {
  private readonly queued: Job[] = [];
  private running: Job | null = null;
  private closed = false;

  /** The promise of a queued or running job with this key, or null. */
  find<T>(key: string): Promise<T> | null {
    if (this.running?.key === key) return this.running.promise as Promise<T>;
    const job = this.queued.find((j) => j.key === key);
    return job ? (job.promise as Promise<T>) : null;
  }

  /** True while a job whose key starts with `prefix` is queued or running. */
  busy(prefix: string): boolean {
    return (this.running?.key.startsWith(prefix) ?? false) || this.queued.some((j) => j.key.startsWith(prefix));
  }

  /** Joins a job with this key, or queues a new one. A high request lifts a queued low job. */
  request<T>(key: string, high: boolean, run: () => Promise<T>): Promise<T> {
    const queued = this.queued.find((j) => j.key === key);
    if (queued) {
      if (high && !queued.high) {
        queued.high = true;
        this.queued.splice(this.queued.indexOf(queued), 1);
        this.insert(queued);
      }
      return queued.promise as Promise<T>;
    }
    if (this.running?.key === key) return this.running.promise as Promise<T>;
    if (this.closed) return Promise.reject(new Error("the evaluation queue is closed"));
    let resolve: (value: unknown) => void = () => {};
    let reject: (err: unknown) => void = () => {};
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that fire and forget must not cause unhandled rejections; awaiting callers still see the error.
    promise.catch(() => undefined);
    this.insert({ key, high, run, promise, resolve, reject, started: false });
    this.pump();
    return promise as Promise<T>;
  }

  /** Renames the running job (called from inside it). */
  rekey(from: string, to: string): void {
    if (this.running?.key === from) this.running.key = to;
  }

  private insert(job: Job): void {
    if (!job.high) {
      this.queued.push(job);
      return;
    }
    const firstLow = this.queued.findIndex((j) => !j.high);
    if (firstLow < 0) this.queued.push(job);
    else this.queued.splice(firstLow, 0, job);
  }

  private pump(): void {
    if (this.running || this.closed) return;
    const job = this.queued.shift();
    if (!job) return;
    this.running = job;
    job.started = true;
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  /** Drops what is queued and waits for the running job. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queued.splice(0)) job.reject(new Error("the evaluation queue is closed"));
    if (this.running) await this.running.promise.catch(() => undefined);
  }

  /** Resolves when nothing is queued or running (tests). */
  async drained(): Promise<void> {
    while (this.running || this.queued.length > 0) {
      if (this.running) await this.running.promise.catch(() => undefined);
      await Bun.sleep(1);
    }
  }
}
