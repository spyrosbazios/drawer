/** A stand-in for measure-worker.ts: a `probe` along x kills it, one along y is never answered, a `slice` is. */
import type { WorkerReply, WorkerRequest } from "../src/measure-protocol";

addEventListener("message", (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.op === "probe" && req.axis === "x") process.exit(1);
  if (req.op === "probe") return;
  const reply: WorkerReply = { id: req.id, ok: true, op: "slice", contours: [] };
  postMessage(reply);
});
