import { HEADER_AUTHOR, MAX_ATTACHMENT_BYTES } from "@drawer/shared/api";
import { invalid } from "../errors.ts";
import { attachmentHeader, isActiveContent } from "../http/download.ts";
import type { Router } from "../http/router.ts";
import { queryInt, readJsonBody } from "../http/validate.ts";
import { answerBody, createSessionBody, fileAttachmentBody, messageBody, newItem, runnerIdentity, runnerPoll, sessionPatch, waitSeconds } from "./input.ts";
import type { Sessions } from "./types.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function author(req: Request): string {
  return req.headers.get(HEADER_AUTHOR)?.trim() || "web";
}

/** Adds /guide, /sessions..., /runners and /runner/work to the router. */
export function registerSessionRoutes(router: Router, sessions: Sessions): void {
  router.add("GET", "/guide", async () => {
    const text = await sessions.guide();
    return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  });

  // ---- people ----
  router.add("GET", "/sessions", ({ url }) => json({ sessions: sessions.list(url.searchParams.get("project") || null) }));
  router.add("POST", "/projects/:slug/sessions", async ({ req, params }) => {
    const body = createSessionBody(await readJsonBody(req));
    return json(await sessions.create(params.slug as string, body, author(req)), 201);
  });
  router.add("GET", "/sessions/:id", ({ url, params }) => json(sessions.detail(params.id as string, queryInt(url, "since", 0, 0, Number.MAX_SAFE_INTEGER))));
  router.add("POST", "/sessions/:id/messages", async ({ req, params }) =>
    json(await sessions.addMessage(params.id as string, messageBody(await readJsonBody(req)), author(req))),
  );
  router.add("POST", "/sessions/:id/stop", async ({ params }) => json(await sessions.stop(params.id as string)));
  router.add("POST", "/sessions/:id/answer", async ({ req, params }) => json(await sessions.answer(params.id as string, answerBody(await readJsonBody(req)))));
  router.add("DELETE", "/sessions/:id", async ({ params }) => {
    await sessions.remove(params.id as string);
    return new Response(null, { status: 204 });
  });
  router.add("GET", "/runners", () => json(sessions.runners()));

  // ---- attachments ----
  router.add("POST", "/projects/:slug/attachments", async ({ req, url, params }) => {
    const name = url.searchParams.get("name")?.trim() ?? "";
    if (name === "") throw invalid("name is required (the file name)");
    if (Number(req.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) throw invalid(`an attachment may be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
    const bytes = new Uint8Array(await req.arrayBuffer());
    return json(await sessions.upload(params.slug as string, name, bytes), 201);
  });
  router.add("GET", "/attachments/:id", ({ url, params }) => {
    const { attachment, file } = sessions.attachment(params.id as string);
    const headers: Record<string, string> = {
      "content-type": attachment.mediaType,
      "x-content-type-options": "nosniff",
      // The bytes of an id never change.
      "cache-control": "private, max-age=31536000, immutable",
    };
    if (isActiveContent(attachment.name)) headers["content-security-policy"] = "sandbox";
    if (url.searchParams.get("download") === "1") headers["content-disposition"] = attachmentHeader(attachment.name);
    return new Response(Bun.file(file), { headers });
  });
  router.add("POST", "/attachments/:id/file", async ({ req, params }) =>
    json(await sessions.fileAttachment(params.id as string, fileAttachmentBody(await readJsonBody(req)), author(req))),
  );

  // ---- runners ----
  router.add("POST", "/runner/work", async ({ req }) => json(await sessions.work(runnerPoll(await readJsonBody(req)), req.signal)));
  router.add("POST", "/sessions/:id/items", async ({ req, url, params }) => {
    const by = runnerIdentity(url);
    return json(await sessions.appendItem(params.id as string, newItem(await readJsonBody(req)), by));
  });
  router.add("PATCH", "/sessions/:id", async ({ req, url, params }) => {
    const by = runnerIdentity(url);
    return json(await sessions.patch(params.id as string, sessionPatch(await readJsonBody(req)), by));
  });
  router.add("GET", "/sessions/:id/answer", async ({ req, url, params }) => {
    const question = url.searchParams.get("question") ?? "";
    if (question === "") throw invalid("question is required");
    return json({ answers: await sessions.waitAnswer(params.id as string, question, waitSeconds(url), req.signal) });
  });
}
